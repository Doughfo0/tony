import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  NativeModules,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { saveLocalProfile, type LocalProfile } from '@/lib/local-profile';

type OnboardingStep = 'welcome' | 'details' | 'permissions';

type LocalOnboardingProps = {
  onComplete: (profile: LocalProfile, watcherEnabled: boolean, message?: string) => void;
};

const phoneWatcher = NativeModules.PhoneCallWatcher;
const callApiUrl = process.env.EXPO_PUBLIC_TONY_API_URL?.replace(/\/+$/, '') ?? '';
const callApiToken = process.env.EXPO_PUBLIC_TONY_CALL_API_TOKEN ?? '';

export function LocalOnboarding({ onComplete }: LocalOnboardingProps) {
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [name, setName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function continueToPermissions() {
    const trimmedName = name.trim();
    const normalizedPhone = phoneNumber.trim().replace(/[\s()-]/g, '');
    if (trimmedName.length < 2) {
      setError('Enter your name to continue.');
      return;
    }
    if (!/^\+[1-9]\d{7,14}$/.test(normalizedPhone)) {
      setError('Enter your phone number with country code, such as +15551234567.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      await saveLocalProfile({ name: trimmedName, phoneNumber: normalizedPhone });
      setPhoneNumber(normalizedPhone);
      setStep('permissions');
    } catch {
      setError('Your details could not be saved securely on this device. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function enableCallWatch() {
    const profile = { name: name.trim(), phoneNumber };
    if (Platform.OS !== 'android' || !phoneWatcher) {
      onComplete(profile, false, 'Call watch is currently available only in the Android app.');
      return;
    }

    setBusy(true);
    setError('');
    try {
      const phonePermission = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
        {
          title: 'Allow call detection',
          message: 'Tony needs phone state access to recognize incoming cellular calls. It does not read your contacts or call history.',
          buttonPositive: 'Allow',
          buttonNegative: 'Not now',
        },
      );
      if (phonePermission !== PermissionsAndroid.RESULTS.GRANTED) {
        onComplete(profile, false, 'Call detection permission was not granted. You can enable call watch later.');
        return;
      }

      if (Platform.Version >= 33) {
        await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS,
          {
            title: 'Show call watch status',
            message: 'Allow notifications so Android can show that call watch is active in the background.',
            buttonPositive: 'Allow',
            buttonNegative: 'Continue without',
          },
        );
      }

      await phoneWatcher.configureOutboundApi(callApiUrl, callApiToken, profile.phoneNumber);
      await phoneWatcher.startWatching();
      onComplete(profile, true);
    } catch {
      setError('Call watch could not be started. You can try enabling it from the app later.');
    } finally {
      setBusy(false);
    }
  }

  function finishWithoutCallWatch() {
    onComplete(
      { name: name.trim(), phoneNumber },
      false,
      'Call watch is off. You can enable it from the app whenever you are ready.',
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.keyboard}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.brandIcon}><View style={styles.brandDot} /></View>
          <Text style={styles.kicker}>TONY / CALL WATCH</Text>

          {step === 'welcome' ? (
            <>
              <Text style={styles.title}>A moment to check.{'\n'}A little more peace.</Text>
              <Text style={styles.description}>
                Tony helps you keep track of incoming calls so you can take a breath and decide what to do next.
              </Text>
              <View style={styles.safetyCard}>
                <Text style={styles.safetyLabel}>A QUICK SCAM-SAFETY REMINDER</Text>
                <Text style={styles.safetyTitle}>You’re in control of the conversation.</Text>
                <Text style={styles.safetyCopy}>
                  Be cautious if a caller pressures you to act urgently, send money, or share a password or verification code. Hang up and contact the organization using a number you trust.
                </Text>
              </View>
              <Text style={styles.disclaimer}>
                Tony records call time and outcome on this device. It does not identify callers or guarantee that a call is safe.
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => setStep('details')}
                style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
              >
                <Text style={styles.primaryLabel}>Get started</Text>
                <Text style={styles.buttonMark}>→</Text>
              </Pressable>
            </>
          ) : step === 'details' ? (
            <>
              <Pressable accessibilityRole="button" onPress={() => setStep('welcome')} style={styles.backButton}>
                <Text style={styles.backLabel}>‹  Back</Text>
              </Pressable>
              <Text style={styles.title}>Let’s set up your call watch.</Text>
              <Text style={styles.description}>
                Your details are saved securely on this phone only. They are not verified or sent to a service.
              </Text>
              <Text style={styles.inputLabel}>YOUR NAME</Text>
              <TextInput
                accessibilityLabel="Your name"
                autoComplete="name"
                autoCapitalize="words"
                editable={!busy}
                onChangeText={setName}
                placeholder="Name"
                placeholderTextColor="#A6AFA8"
                returnKeyType="next"
                style={styles.input}
                textContentType="name"
                value={name}
              />
              <Text style={styles.inputLabel}>PHONE NUMBER</Text>
              <TextInput
                accessibilityLabel="Phone number with country code"
                autoComplete="tel"
                editable={!busy}
                keyboardType="phone-pad"
                onChangeText={setPhoneNumber}
                placeholder="+1 555 123 4567"
                placeholderTextColor="#A6AFA8"
                style={styles.input}
                textContentType="telephoneNumber"
                value={phoneNumber}
              />
              <Text style={styles.fieldHint}>Include your country code. LiveKit will call this number after you answer an incoming call.</Text>
              {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={continueToPermissions}
                style={({ pressed }) => [styles.primaryButton, busy && styles.disabled, pressed && !busy && styles.buttonPressed]}
              >
                {busy ? <ActivityIndicator color="#F5F8F2" /> : <Text style={styles.primaryLabel}>Continue</Text>}
                {!busy ? <Text style={styles.buttonMark}>→</Text> : null}
              </Pressable>
            </>
          ) : (
            <>
              <Pressable accessibilityRole="button" onPress={() => setStep('details')} style={styles.backButton}>
                <Text style={styles.backLabel}>‹  Back</Text>
              </Pressable>
              <Text style={styles.title}>Turn on call watch?</Text>
              <Text style={styles.description}>
                Android will ask for permission to detect cellular call states. Tony saves the call time and whether it was answered or missed on this device.
              </Text>
              <View style={styles.safetyCard}>
                <Text style={styles.safetyLabel}>YOUR PRIVACY</Text>
                <Text style={styles.safetyCopy}>
                  We don’t read your contacts or call history, and your profile stays on this device. You can say no and enable call watch later.
                </Text>
              </View>
              {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={enableCallWatch}
                style={({ pressed }) => [styles.primaryButton, busy && styles.disabled, pressed && !busy && styles.buttonPressed]}
              >
                {busy ? <ActivityIndicator color="#F5F8F2" /> : <Text style={styles.primaryLabel}>Allow call watch</Text>}
                {!busy ? <Text style={styles.buttonMark}>→</Text> : null}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={busy}
                onPress={finishWithoutCallWatch}
                style={styles.textButton}
              >
                <Text style={styles.textButtonLabel}>Not now</Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#F5F6F2' },
  keyboard: { flex: 1 },
  content: { flexGrow: 1, justifyContent: 'center', width: '100%', maxWidth: 480, alignSelf: 'center', paddingHorizontal: 26, paddingVertical: 28 },
  brandIcon: { width: 46, height: 46, borderRadius: 15, backgroundColor: '#1D3A32', alignItems: 'center', justifyContent: 'center', marginBottom: 19 },
  brandDot: { width: 13, height: 13, borderRadius: 7, backgroundColor: '#C8F36B' },
  kicker: { color: '#819087', fontSize: 10, fontWeight: '800', letterSpacing: 1.6 },
  title: { color: '#20352D', fontSize: 29, lineHeight: 35, fontWeight: '700', letterSpacing: -0.8, marginTop: 10 },
  description: { color: '#77837A', fontSize: 14, lineHeight: 21, marginTop: 9, marginBottom: 22 },
  safetyCard: { backgroundColor: '#1D3A32', borderRadius: 22, padding: 20 },
  safetyLabel: { color: '#C8F36B', fontSize: 9, fontWeight: '800', letterSpacing: 1.4 },
  safetyTitle: { color: '#F5F8F2', fontSize: 17, lineHeight: 23, fontWeight: '700', marginTop: 12 },
  safetyCopy: { color: '#C6D2C9', fontSize: 12, lineHeight: 19, marginTop: 8 },
  disclaimer: { color: '#87928A', fontSize: 11, lineHeight: 17, marginTop: 15 },
  inputLabel: { color: '#819087', fontSize: 9, fontWeight: '800', letterSpacing: 1.2, marginBottom: 7, marginTop: 15 },
  input: { height: 54, borderRadius: 15, borderWidth: 1, borderColor: '#DDE4DC', backgroundColor: '#FFFFFF', color: '#26392F', fontSize: 16, paddingHorizontal: 15 },
  fieldHint: { color: '#87928A', fontSize: 10, lineHeight: 15, marginTop: 7 },
  error: { color: '#AE5546', fontSize: 12, lineHeight: 18, marginTop: 12 },
  primaryButton: { minHeight: 54, borderRadius: 16, backgroundColor: '#1D3A32', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, marginTop: 22, paddingHorizontal: 18 },
  primaryLabel: { color: '#F5F8F2', fontSize: 14, fontWeight: '700' },
  buttonMark: { color: '#C8F36B', fontSize: 19, fontWeight: '600' },
  buttonPressed: { backgroundColor: '#294C3F' },
  disabled: { opacity: 0.55 },
  backButton: { alignSelf: 'flex-start', paddingVertical: 12, paddingRight: 12, marginTop: 2 },
  backLabel: { color: '#638A2F', fontSize: 13, fontWeight: '700' },
  textButton: { alignSelf: 'center', padding: 14, marginTop: 3 },
  textButtonLabel: { color: '#77837A', fontSize: 13, fontWeight: '700' },
});
