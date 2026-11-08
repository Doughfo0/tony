const fs = require('node:fs/promises');
const path = require('node:path');
const { withAndroidManifest, withDangerousMod, withMainApplication } = require('expo/config-plugins');

function withPhoneCallWatcher(config) {
  config = withAndroidManifest(config, (mod) => {
    const manifest = mod.modResults.manifest;
    const permissions = manifest['uses-permission'] ?? [];
    for (const name of [
      'android.permission.READ_PHONE_STATE',
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_SPECIAL_USE',
      'android.permission.POST_NOTIFICATIONS',
    ]) {
      if (!permissions.some((permission) => permission.$?.['android:name'] === name)) {
        permissions.push({ $: { 'android:name': name } });
      }
    }
    manifest['uses-permission'] = permissions;

    const application = manifest.application?.[0];
    if (!application) throw new Error('Android application element was not generated.');
    application.service ??= [];
    if (!application.service.some((service) => service.$?.['android:name'] === '.PhoneCallWatcherService')) {
      application.service.push({
        $: {
          'android:name': '.PhoneCallWatcherService',
          'android:exported': 'false',
          'android:foregroundServiceType': 'specialUse',
        },
        property: [{
          $: {
            'android:name': 'android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE',
            'android:value': 'User-enabled incoming phone call state monitoring',
          },
        }],
      });
    }
    return mod;
  });

  config = withMainApplication(config, (mod) => {
    const source = mod.modResults.contents;
    if (!source.includes('PhoneCallWatcherPackage()')) {
      const marker = '// add(MyReactNativePackage())';
      if (!source.includes(marker)) throw new Error('Could not find the Expo MainApplication package registration point.');
      mod.modResults.contents = source.replace(marker, `${marker}\n          add(PhoneCallWatcherPackage())`);
    }
    return mod;
  });

  return withDangerousMod(config, ['android', async (mod) => {
    const packageName = mod.android.package;
    if (!packageName) throw new Error('android.package must be set to use PhoneCallWatcher.');
    const sourceDir = path.join(mod.modRequest.platformProjectRoot, 'app', 'src', 'main', 'java', packageName.replaceAll('.', path.sep));
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'PhoneCallWatcherModule.kt'), moduleSource(packageName));
    await fs.writeFile(path.join(sourceDir, 'PhoneCallWatcherPackage.kt'), packageSource(packageName));
    await fs.writeFile(path.join(sourceDir, 'PhoneCallWatcherService.kt'), serviceSource(packageName));
    return mod;
  }]);
}

function moduleSource(packageName) {
  return `package ${packageName}

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

class PhoneCallWatcherModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  init { reactContext = context }

  override fun getName() = "PhoneCallWatcher"

  @ReactMethod
  fun startWatching(promise: Promise) {
    if (ContextCompat.checkSelfPermission(reactApplicationContext, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
      promise.reject("PHONE_PERMISSION", "READ_PHONE_STATE permission has not been granted")
      return
    }
    try {
      val intent = Intent(reactApplicationContext, PhoneCallWatcherService::class.java).setAction(PhoneCallWatcherService.ACTION_START)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) reactApplicationContext.startForegroundService(intent) else reactApplicationContext.startService(intent)
      promise.resolve(true)
    } catch (error: Exception) {
      promise.reject("WATCH_START_FAILED", error)
    }
  }

  @ReactMethod
  fun stopWatching(promise: Promise) {
    val intent = Intent(reactApplicationContext, PhoneCallWatcherService::class.java).setAction(PhoneCallWatcherService.ACTION_STOP)
    reactApplicationContext.startService(intent)
    promise.resolve(true)
  }

  @ReactMethod
  fun getCallEvents(promise: Promise) {
    promise.resolve(PhoneCallEventStore.read(reactApplicationContext))
  }

  @ReactMethod
  fun configureOutboundApi(url: String, token: String, destinationNumber: String, promise: Promise) {
    PhoneCallOutboundClient.configure(reactApplicationContext, url, token, destinationNumber)
    promise.resolve(true)
  }

  @ReactMethod
  fun isWatching(promise: Promise) {
    promise.resolve(PhoneCallEventStore.isWatching(reactApplicationContext))
  }

  override fun invalidate() {
    if (reactContext === reactApplicationContext) reactContext = null
    super.invalidate()
  }

  companion object {
    @Volatile private var reactContext: ReactApplicationContext? = null

    fun emitCallEvent(event: com.facebook.react.bridge.WritableMap) {
      val context = reactContext ?: return
      if (context.hasActiveReactInstance()) {
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java).emit("phoneCallState", event)
      }
    }
  }
}
`;
}

function packageSource(packageName) {
  return `package ${packageName}

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class PhoneCallWatcherPackage : ReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = listOf(PhoneCallWatcherModule(context))
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}
`;
}

function serviceSource(packageName) {
  return `package ${packageName}

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.telephony.PhoneStateListener
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executor
import java.util.concurrent.Executors

object PhoneCallEventStore {
  private const val PREFS = "tony_call_watcher"
  private const val EVENTS = "events"
  private const val ENABLED = "enabled"
  private const val MAX_EVENTS = 50
  private var activeId: String? = null

  @Synchronized fun isWatching(context: Context) = PhoneCallWatcherService.isRunning

  @Synchronized fun setWatching(context: Context, value: Boolean) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(ENABLED, value).apply()
  }

  @Synchronized fun read(context: Context): com.facebook.react.bridge.WritableArray {
    val saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(EVENTS, "[]") ?: "[]"
    val result = Arguments.createArray()
    val values = JSONArray(saved)
    for (i in 0 until values.length()) {
      val item = values.optJSONObject(i) ?: continue
      val row = Arguments.createMap()
      row.putString("id", item.optString("id"))
      row.putDouble("at", item.optLong("at").toDouble())
      row.putString("result", item.optString("result"))
      if (item.has("outboundStatus")) row.putString("outboundStatus", item.optString("outboundStatus"))
      result.pushMap(row)
    }
    return result
  }

  @Synchronized fun onState(context: Context, state: Int) {
    val values = JSONArray(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(EVENTS, "[]") ?: "[]")
    val now = System.currentTimeMillis()
    when (state) {
      TelephonyManager.CALL_STATE_RINGING -> {
        activeId = now.toString()
        val item = JSONObject().put("id", activeId).put("at", now).put("result", "ringing")
        val next = JSONArray().put(item)
        for (i in 0 until minOf(values.length(), MAX_EVENTS - 1)) next.put(values.getJSONObject(i))
        save(context, next)
        PhoneCallOutboundClient.request(context, activeId!!, now)
      }
      TelephonyManager.CALL_STATE_OFFHOOK -> updateActive(context, values, "answered")
      TelephonyManager.CALL_STATE_IDLE -> {
        val current = activeId?.let { id -> (0 until values.length()).firstOrNull { values.optJSONObject(it)?.optString("id") == id } }
        if (current != null && values.optJSONObject(current)?.optString("result") == "ringing") updateActive(context, values, "missed")
        activeId = null
      }
    }
  }

  private fun updateActive(context: Context, values: JSONArray, result: String) {
    val id = activeId ?: return
    for (i in 0 until values.length()) {
      val item = values.optJSONObject(i) ?: continue
      if (item.optString("id") == id) {
        item.put("result", result)
        save(context, values)
        return
      }
    }
  }

  private fun save(context: Context, values: JSONArray) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(EVENTS, values.toString()).apply()
    val item = values.optJSONObject(0) ?: return
    emit(item)
  }

  @Synchronized fun setOutboundStatus(context: Context, callId: String, status: String) {
    val values = JSONArray(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(EVENTS, "[]") ?: "[]")
    for (i in 0 until values.length()) {
      val item = values.optJSONObject(i) ?: continue
      if (item.optString("id") == callId) {
        item.put("outboundStatus", status)
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(EVENTS, values.toString()).apply()
        emit(item)
        return
      }
    }
  }

  private fun emit(item: JSONObject) {
    val event = Arguments.createMap().apply {
      putString("state", when (item.optString("result")) { "answered" -> "offhook"; "missed" -> "idle"; else -> "ringing" })
      putDouble("at", item.optLong("at").toDouble())
      putString("id", item.optString("id"))
      putString("result", item.optString("result"))
      if (item.has("outboundStatus")) putString("outboundStatus", item.optString("outboundStatus"))
    }
    PhoneCallWatcherModule.emitCallEvent(event)
  }
}

object PhoneCallOutboundClient {
  private const val PREFS = "tony_call_watcher"
  private const val API_URL = "outbound_api_url"
  private const val API_TOKEN = "outbound_api_token"
  private const val DESTINATION = "outbound_destination"
  private val executor = Executors.newFixedThreadPool(3)

  fun configure(context: Context, url: String, token: String, destinationNumber: String) {
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putString(API_URL, url.trim().trimEnd('/'))
      .putString(API_TOKEN, token.trim())
      .putString(DESTINATION, destinationNumber.trim())
      .apply()
  }

  fun request(context: Context, callId: String, at: Long) {
    executor.execute {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      val baseUrl = prefs.getString(API_URL, "") ?: ""
      val token = prefs.getString(API_TOKEN, "") ?: ""
      val destinationNumber = prefs.getString(DESTINATION, "") ?: ""
      if (baseUrl.isBlank() || token.length < 32 || baseUrl.contains("example.com") || token.startsWith("replace-")) {
        PhoneCallEventStore.setOutboundStatus(context, callId, "Dial-out server not configured")
        return@execute
      }

      var status = "Outbound call failed"
      try {
        val connection = URL("${'$'}baseUrl/api/calls/incoming").openConnection() as HttpURLConnection
        connection.requestMethod = "POST"
        // Render's free service can take about a minute to wake after idling.
        connection.connectTimeout = 75000
        connection.readTimeout = 75000
        connection.doOutput = true
        connection.setRequestProperty("Authorization", "Bearer ${'$'}token")
        connection.setRequestProperty("Content-Type", "application/json")
        connection.outputStream.use { output ->
          output.write(JSONObject().put("callId", callId).put("at", at).put("phoneNumber", destinationNumber).toString().toByteArray(Charsets.UTF_8))
        }
        val code = connection.responseCode
        status = when {
          code in 200..299 -> "Outbound call started"
          code == 401 -> "Dial-out server rejected its app token"
          code == 429 -> "Dial-out temporarily rate limited"
          code == 503 -> "Dial-out server is not configured"
          else -> "Outbound call failed"
        }
        connection.disconnect()
      } catch (_: Exception) {
        status = "Could not reach dial-out server"
      }
      PhoneCallEventStore.setOutboundStatus(context, callId, status)
    }
  }
}

class PhoneCallWatcherService : Service() {
  private lateinit var telephony: TelephonyManager
  private var legacyListener: PhoneStateListener? = null
  private var modernListener: TelephonyCallback? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopWatcher()
      return START_NOT_STICKY
    }
    if (ContextCompat.checkSelfPermission(this, Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
      stopSelf()
      return START_NOT_STICKY
    }
    startAsForeground()
    isRunning = true
    PhoneCallEventStore.setWatching(this, true)
    registerCallListener()
    return START_STICKY
  }

  private fun startAsForeground() {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Call watch", NotificationManager.IMPORTANCE_LOW).apply { description = "Shows when call watch is active" }
    )
    val notification = buildNotification()
    if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    else startForeground(NOTIFICATION_ID, notification)
  }

  @Suppress("DEPRECATION")
  private fun buildNotification(): Notification {
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID) else Notification.Builder(this)
    return builder.setSmallIcon(android.R.drawable.stat_sys_phone_call)
      .setContentTitle("Call watch is on")
      .setContentText("Listening for incoming calls")
      .setOngoing(true)
      .setCategory(Notification.CATEGORY_SERVICE)
      .build()
  }

  private fun registerCallListener() {
    if (::telephony.isInitialized) return
    telephony = getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val callback = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
        override fun onCallStateChanged(state: Int) = PhoneCallEventStore.onState(this@PhoneCallWatcherService, state)
      }
      modernListener = callback
      telephony.registerTelephonyCallback(ContextCompat.getMainExecutor(this), callback)
    } else {
      val onStateChanged: (Int) -> Unit = { state -> PhoneCallEventStore.onState(this, state) }
      val listener = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        object : PhoneStateListener(ContextCompat.getMainExecutor(this)) {
          override fun onCallStateChanged(state: Int, phoneNumber: String?) = onStateChanged(state)
        }
      } else {
        object : PhoneStateListener() {
          override fun onCallStateChanged(state: Int, phoneNumber: String?) = onStateChanged(state)
        }
      }
      legacyListener = listener
      @Suppress("DEPRECATION") telephony.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
    }
  }

  private fun stopWatcher() {
    if (::telephony.isInitialized) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) modernListener?.let { telephony.unregisterTelephonyCallback(it) }
      else unregisterLegacyListener()
    }
    legacyListener = null
    modernListener = null
    PhoneCallEventStore.setWatching(this, false)
    isRunning = false
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE) else @Suppress("DEPRECATION") stopForeground(true)
    stopSelf()
  }

  override fun onDestroy() {
    if (isRunning) stopWatcher()
    super.onDestroy()
  }

  @Suppress("DEPRECATION")
  private fun unregisterLegacyListener() {
    legacyListener?.let { telephony.listen(it, PhoneStateListener.LISTEN_NONE) }
  }

  companion object {
    const val ACTION_START = "${'$'}{BuildConfig.APPLICATION_ID}.CALL_WATCH_START"
    const val ACTION_STOP = "${'$'}{BuildConfig.APPLICATION_ID}.CALL_WATCH_STOP"
    private const val CHANNEL_ID = "tony_call_watch"
    private const val NOTIFICATION_ID = 7104
    @Volatile var isRunning = false
  }
}
`;
}

module.exports = withPhoneCallWatcher;
