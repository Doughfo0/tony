import { useCallback, useEffect, useState } from 'react';
import {
  AppState,
  NativeEventEmitter,
  NativeModules,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LocalOnboarding } from '@/components/local-onboarding';
import { loadLocalProfile, type LocalProfile } from '@/lib/local-profile';

type CallEvent = { id?: string; state: 'ringing' | 'offhook' | 'idle'; at: number; result?: CallRecord['result']; outboundStatus?: string };
type CallRecord = { id: string; at: number; result: 'ringing' | 'answered' | 'missed'; outboundStatus?: string };

const MAX_CALLS = 50;
const CALL_API_URL = process.env.EXPO_PUBLIC_TONY_API_URL?.replace(/\/+$/, '') ?? '';
const CALL_API_TOKEN = process.env.EXPO_PUBLIC_TONY_CALL_API_TOKEN ?? '';
const phoneWatcher = NativeModules.PhoneCallWatcher;

function formatCallTime(timestamp: number) {
  const date = new Date(timestamp);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  const isToday = date.toDateString() === today.toDateString();
  if (isToday) return `Today, ${time}`;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

export default function CallActivityScreen() {
  const [profile, setProfile] = useState<LocalProfile | null>(null);
  const [profileReady, setProfileReady] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [onboardingMessage, setOnboardingMessage] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [ringing, setRinging] = useState(false);
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [outboundStatuses, setOutboundStatuses] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  useEffect(() => {
    if (Platform.OS !== 'android' || !phoneWatcher) return;
    phoneWatcher.configureOutboundApi(CALL_API_URL, CALL_API_TOKEN, profile?.phoneNumber ?? '').catch(() => {
      setError('Outbound call server settings could not be loaded.');
    });
  }, [profile?.phoneNumber]);

  useEffect(() => {
    let active = true;
    void loadLocalProfile().then((savedProfile) => {
      if (active) setProfile(savedProfile);
    }).catch(() => {
      if (active) setProfileError('Saved details could not be read. You can enter them again to save a new local profile.');
    }).finally(() => {
      if (active) setProfileReady(true);
    });
    return () => { active = false; };
  }, []);

  const refreshNativeState = useCallback(async () => {
    if (Platform.OS !== 'android' || !phoneWatcher) return;
    try {
      const [nativeCalls, isWatching] = await Promise.all([
        phoneWatcher.getCallEvents(),
        phoneWatcher.isWatching(),
      ]);
      const records = (nativeCalls as CallRecord[]).slice(0, MAX_CALLS);
      setCalls(records);
      setOutboundStatuses(Object.fromEntries(records.filter((call) => call.outboundStatus).map((call) => [call.id, call.outboundStatus!])));
      setEnabled(isWatching);
    } catch {
      setError('Call watch status could not be read. Reopen the app and try again.');
    }
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'android' || !phoneWatcher) return;
    const refreshTimer = setTimeout(() => { void refreshNativeState(); }, 0);
    const emitter = new NativeEventEmitter(phoneWatcher);
    const subscription = emitter.addListener('phoneCallState', (rawEvent) => {
      const event = rawEvent as CallEvent;
      const id = event.id ?? `${event.at}`;
      const result = event.result ?? (event.state === 'offhook' ? 'answered' : event.state === 'idle' ? 'missed' : 'ringing');
      const record: CallRecord = { id, at: event.at, result, outboundStatus: event.outboundStatus };
      setCalls((current) => [record, ...current.filter((call) => call.id !== id)].slice(0, MAX_CALLS));
      setRinging(event.state === 'ringing');
      if (event.outboundStatus) {
        setOutboundStatuses((current) => ({ ...current, [id]: event.outboundStatus! }));
      }
    });

    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refreshNativeState();
    });
    return () => {
      clearTimeout(refreshTimer);
      subscription.remove();
      appState.remove();
    };
  }, [refreshNativeState]);

  async function toggleWatcher() {
    if (Platform.OS !== 'android' || !phoneWatcher) {
      setError('Call detection is available in the Android app.');
      return;
    }
    if (enabled) {
      phoneWatcher.stopWatching();
      setEnabled(false);
      return;
    }
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE, {
      title: 'Allow call detection',
      message: 'Tony needs phone state access to recognize incoming cellular calls. It does not read your contacts or call history.',
      buttonPositive: 'Allow',
      buttonNegative: 'Not now',
    });
    if (result !== PermissionsAndroid.RESULTS.GRANTED) {
      setError('Phone permission is needed to detect incoming calls.');
      return;
    }
    if (Platform.Version >= 33) {
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS, {
        title: 'Show call watch status',
        message: 'Allow notifications so Android can show that call watch is active in the background.',
        buttonPositive: 'Allow',
        buttonNegative: 'Continue without',
      });
    }
    setError('');
    try {
      await phoneWatcher.configureOutboundApi(CALL_API_URL, CALL_API_TOKEN, profile?.phoneNumber ?? '');
      await phoneWatcher.startWatching();
      setEnabled(true);
    } catch {
      setError('Could not start background call watch. Please check phone permission and try again.');
    }
  }

  function finishOnboarding(savedProfile: LocalProfile, watcherEnabled: boolean, message?: string) {
    setProfile(savedProfile);
    setEnabled(watcherEnabled);
    setOnboardingMessage(message ?? '');
  }

  if (!profileReady) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.authLoading}>
          <Text style={styles.authLoadingText}>Loading your local profile…</Text>
        </View>
      </SafeAreaView>
    );
  }
  if (!profile) {
    return <LocalOnboarding onComplete={finishOnboarding} />;
  }

  const callsToday = calls.filter((call) => new Date(call.at).toDateString() === new Date().toDateString()).length;

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <View style={styles.brandIcon}><View style={styles.brandDot} /></View>
          <View style={styles.brandText}>
            <Text style={styles.kicker}>TONY / {profile.name.toUpperCase()}</Text>
            <Text style={styles.title}>Call activity</Text>
          </View>
          <View style={[styles.liveChip, enabled && styles.liveChipOn]}>
            <View style={[styles.liveDot, enabled && styles.liveDotOn]} />
            <Text style={[styles.liveText, enabled && styles.liveTextOn]}>{enabled ? 'WATCHING' : 'PAUSED'}</Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={[styles.hero, ringing && styles.heroRinging]}>
            <View style={styles.heroTop}>
              <Text style={styles.heroLabel}>{ringing ? 'INCOMING CALL' : 'CALL WATCH'}</Text>
              <View style={styles.waveBars}>
                <View style={[styles.waveBar, styles.waveBarShort]} />
                <View style={styles.waveBar} />
                <View style={[styles.waveBar, styles.waveBarTall]} />
                <View style={styles.waveBar} />
                <View style={[styles.waveBar, styles.waveBarShort]} />
              </View>
            </View>
            <View style={styles.heroMain}>
              <View style={styles.phoneBadge}><Text style={styles.phoneGlyph}>T</Text></View>
              <View style={styles.heroText}>
                <Text style={styles.heroTitle}>{ringing ? 'Your phone is ringing' : enabled ? 'Listening for calls' : 'Never miss a call alert'}</Text>
                <Text style={styles.heroDescription}>
                  {ringing ? 'Incoming call detected on this phone.' : enabled ? 'Incoming calls will show up in your activity.' : 'Turn on call watch to keep a record of incoming calls.'}
                </Text>
              </View>
            </View>
            <View style={styles.heroFooter}>
              <View style={styles.heroFootItem}><Text style={styles.heroFootLabel}>TODAY</Text><Text style={styles.heroFootValue}>{callsToday} {callsToday === 1 ? 'call' : 'calls'}</Text></View>
              <View style={styles.heroDivider} />
              <View style={styles.heroFootItem}><Text style={styles.heroFootLabel}>ON THIS DEVICE</Text><Text style={styles.heroFootValue}>Private history</Text></View>
            </View>
          </View>

          <View style={styles.listHeading}>
            <View>
              <Text style={styles.sectionTitle}>Recent calls</Text>
              <Text style={styles.sectionSub}>{calls.length ? `${calls.length} saved on this device` : 'Your incoming calls will appear here'}</Text>
            </View>
            <View style={styles.countBubble}><Text style={styles.countText}>{calls.length}</Text></View>
          </View>

          {calls.length === 0 ? (
            <View style={styles.emptyCard}>
              <View style={styles.emptyIcon}><Text style={styles.emptyGlyph}>↗</Text></View>
              <Text style={styles.emptyTitle}>No calls yet</Text>
              <Text style={styles.emptyCopy}>When your phone rings while call watch is on, the time and result will be saved here.</Text>
            </View>
          ) : (
            <View style={styles.callList}>
              {calls.map((call, index) => (
                <View key={call.id} style={[styles.callRow, index === calls.length - 1 && styles.callRowLast]}>
                  <View style={[styles.callIcon, call.result === 'missed' && styles.callIconMissed, call.result === 'ringing' && styles.callIconRinging]}>
                    <Text style={[styles.callGlyph, call.result === 'missed' && styles.callGlyphMissed]}>{call.result === 'missed' ? '↙' : '↗'}</Text>
                  </View>
                  <View style={styles.callDetails}>
                    <Text style={styles.callerName}>Incoming call</Text>
                    <Text style={styles.callTime}>{formatCallTime(call.at)}</Text>
                    {(outboundStatuses[call.id] ?? call.outboundStatus) ? <Text style={styles.outboundStatus}>{outboundStatuses[call.id] ?? call.outboundStatus}</Text> : null}
                  </View>
                  <View style={[styles.resultPill, call.result === 'missed' && styles.resultMissed, call.result === 'ringing' && styles.resultRinging]}>
                    <Text style={[styles.resultText, call.result === 'missed' && styles.resultTextMissed, call.result === 'ringing' && styles.resultTextRinging]}>
                      {call.result === 'answered' ? 'Answered' : call.result === 'missed' ? 'Missed' : 'Ringing'}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}

          <View style={styles.privacyCard}>
            <Text style={styles.privacyIcon}>◇</Text>
            <Text style={styles.privacyCopy}>Your name, phone number, and call times are stored only on this device. Tony does not read your contacts or call history.</Text>
          </View>
          <View style={styles.accountRow}>
            <Text style={styles.accountPhone}>YOUR NUMBER</Text>
            <Text style={styles.accountPhoneValue}>{profile.phoneNumber}</Text>
          </View>
          {onboardingMessage ? <Text style={styles.onboardingMessage}>{onboardingMessage}</Text> : null}
          {profileError ? <Text style={styles.error}>{profileError}</Text> : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </ScrollView>

        <View style={styles.bottom}>
          <Pressable onPress={toggleWatcher} style={({ pressed }) => [styles.button, enabled && styles.buttonPause, pressed && styles.buttonPressed]}>
            <Text style={[styles.buttonLabel, enabled && styles.buttonLabelPause]}>{enabled ? 'Pause call watch' : 'Enable call watch'}</Text>
            <Text style={[styles.buttonMark, enabled && styles.buttonLabelPause]}>{enabled ? 'Ⅱ' : '→'}</Text>
          </Pressable>
          <Text style={styles.helper}>
            {enabled
              ? CALL_API_URL
                ? 'Call watch continues in the background. Incoming calls trigger the configured LiveKit dial-out.'
                : 'Call watch continues in the background. Add the dial-out server URL to enable LiveKit calls.'
              : 'You can pause call watch at any time.'}
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F6F2' },
  authLoading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  authLoadingText: { color: '#77837A', fontSize: 13 },
  screen: { flex: 1, maxWidth: 560, width: '100%', alignSelf: 'center' },
  header: { height: 72, paddingHorizontal: 22, flexDirection: 'row', alignItems: 'center', gap: 12 },
  brandIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: '#1D3A32', alignItems: 'center', justifyContent: 'center' },
  brandDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#C8F36B' },
  brandText: { gap: 2 }, kicker: { color: '#819087', fontSize: 9, fontWeight: '800', letterSpacing: 1.5 },
  title: { color: '#20352D', fontSize: 19, fontWeight: '700', letterSpacing: -0.3 },
  liveChip: { marginLeft: 'auto', height: 29, paddingHorizontal: 10, borderRadius: 15, borderWidth: 1, borderColor: '#DFE4DE', backgroundColor: '#ECEFEB', flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveChipOn: { backgroundColor: '#EAF4D9', borderColor: '#D7E9BD' }, liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#99A39B' }, liveDotOn: { backgroundColor: '#80B13E' }, liveText: { color: '#758178', fontSize: 9, fontWeight: '800', letterSpacing: 0.8 }, liveTextOn: { color: '#638A2F' },
  scrollContent: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 18 },
  hero: { backgroundColor: '#1D3A32', borderRadius: 26, padding: 22, minHeight: 218, overflow: 'hidden' }, heroRinging: { backgroundColor: '#244B3D' },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, heroLabel: { color: '#C5D1C9', fontSize: 9, fontWeight: '800', letterSpacing: 1.5 },
  waveBars: { height: 18, flexDirection: 'row', alignItems: 'center', gap: 3 }, waveBar: { width: 3, height: 10, borderRadius: 2, backgroundColor: '#C8F36B' }, waveBarShort: { height: 6 }, waveBarTall: { height: 16 },
  heroMain: { flexDirection: 'row', alignItems: 'center', gap: 15, marginTop: 23 }, phoneBadge: { height: 58, width: 58, borderRadius: 20, backgroundColor: '#294C3F', borderWidth: 1, borderColor: '#3D6251', alignItems: 'center', justifyContent: 'center' }, phoneGlyph: { color: '#C8F36B', fontWeight: '800', fontSize: 25 },
  heroText: { flex: 1 }, heroTitle: { color: '#F5F8F2', fontSize: 19, fontWeight: '700', letterSpacing: -0.4 }, heroDescription: { color: '#BFCEC3', fontSize: 12, lineHeight: 17, marginTop: 5, maxWidth: 255 },
  heroFooter: { marginTop: 21, paddingTop: 14, borderTopWidth: 1, borderTopColor: '#3A564A', flexDirection: 'row', alignItems: 'center', gap: 18 }, heroFootItem: { gap: 4 }, heroFootLabel: { color: '#9FB0A5', fontSize: 8, fontWeight: '800', letterSpacing: 1.1 }, heroFootValue: { color: '#F1F5EF', fontSize: 12, fontWeight: '600' }, heroDivider: { width: 1, height: 27, backgroundColor: '#3A564A' },
  listHeading: { marginTop: 26, marginBottom: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, sectionTitle: { color: '#23372E', fontSize: 17, fontWeight: '700' }, sectionSub: { color: '#87928A', fontSize: 11, marginTop: 3 }, countBubble: { minWidth: 28, height: 28, borderRadius: 14, paddingHorizontal: 8, backgroundColor: '#E9EEE6', alignItems: 'center', justifyContent: 'center' }, countText: { color: '#65736A', fontSize: 11, fontWeight: '700' },
  emptyCard: { minHeight: 172, backgroundColor: '#FFFFFF', borderRadius: 20, borderWidth: 1, borderColor: '#E9ECE7', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 26, paddingVertical: 24 }, emptyIcon: { width: 40, height: 40, borderRadius: 14, backgroundColor: '#EFF4E7', alignItems: 'center', justifyContent: 'center' }, emptyGlyph: { color: '#789C4B', fontSize: 22 }, emptyTitle: { color: '#33443A', fontSize: 14, fontWeight: '700', marginTop: 12 }, emptyCopy: { color: '#87928A', fontSize: 11, textAlign: 'center', lineHeight: 17, marginTop: 5, maxWidth: 250 },
  callList: { backgroundColor: '#FFFFFF', borderRadius: 20, borderWidth: 1, borderColor: '#E9ECE7', paddingHorizontal: 15 }, callRow: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 11, borderBottomWidth: 1, borderBottomColor: '#F0F2EE' }, callRowLast: { borderBottomWidth: 0 }, callIcon: { width: 39, height: 39, borderRadius: 14, backgroundColor: '#EAF3DE', alignItems: 'center', justifyContent: 'center' }, callIconMissed: { backgroundColor: '#FBECE8' }, callIconRinging: { backgroundColor: '#E8F3DA' }, callGlyph: { color: '#70933C', fontSize: 20, fontWeight: '600' }, callGlyphMissed: { color: '#C36C57' }, callDetails: { flex: 1 }, callerName: { color: '#2B3D33', fontSize: 13, fontWeight: '700' }, callTime: { color: '#89938C', fontSize: 11, marginTop: 4 }, outboundStatus: { color: '#638A2F', fontSize: 10, marginTop: 4, fontWeight: '600' }, resultPill: { paddingHorizontal: 9, paddingVertical: 6, borderRadius: 9, backgroundColor: '#EFF4E7' }, resultMissed: { backgroundColor: '#FBECE8' }, resultRinging: { backgroundColor: '#F5F2DB' }, resultText: { color: '#6E8D3C', fontSize: 9, fontWeight: '700' }, resultTextMissed: { color: '#B76551' }, resultTextRinging: { color: '#9B8335', fontSize: 9, fontWeight: '700' },
  privacyCard: { marginTop: 13, backgroundColor: '#EBEEE8', borderRadius: 15, paddingHorizontal: 13, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 9 }, privacyIcon: { color: '#779447', fontSize: 18 }, privacyCopy: { flex: 1, color: '#77837A', fontSize: 10, lineHeight: 15 }, error: { color: '#AE5546', fontSize: 11, marginTop: 10, textAlign: 'center' },
  accountRow: { marginTop: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 2 },
  accountPhone: { color: '#77837A', fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },
  accountPhoneValue: { color: '#33443A', fontSize: 11, fontWeight: '600' },
  onboardingMessage: { color: '#638A2F', fontSize: 11, marginTop: 10, textAlign: 'center' },
  bottom: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 12 }, button: { height: 54, borderRadius: 17, backgroundColor: '#1D3A32', alignItems: 'center', justifyContent: 'center', flexDirection: 'row' }, buttonPause: { backgroundColor: '#E8ECE6', borderWidth: 1, borderColor: '#D9E0D8' }, buttonPressed: { opacity: 0.8, transform: [{ scale: 0.99 }] }, buttonLabel: { color: '#F4F7F1', fontSize: 14, fontWeight: '700' }, buttonLabelPause: { color: '#40564A' }, buttonMark: { position: 'absolute', right: 18, color: '#C8F36B', fontSize: 18 }, helper: { color: '#8D9890', fontSize: 10, textAlign: 'center', marginTop: 8 },
});
