import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

const PROFILE_KEY = 'tony.local-profile';

const profileStorage = Platform.OS === 'web'
  ? {
      getItem: (key: string) => AsyncStorage.getItem(key),
      setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
    }
  : {
      getItem: (key: string) => SecureStore.getItemAsync(key),
      setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
    };

export type LocalProfile = {
  name: string;
  phoneNumber: string;
};

export async function loadLocalProfile(): Promise<LocalProfile | null> {
  const saved = await profileStorage.getItem(PROFILE_KEY);
  if (!saved) return null;

  const parsed: unknown = JSON.parse(saved);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('name' in parsed) ||
    typeof parsed.name !== 'string' ||
    !('phoneNumber' in parsed) ||
    typeof parsed.phoneNumber !== 'string'
  ) {
    throw new Error('Saved profile has an invalid format.');
  }
  return { name: parsed.name, phoneNumber: parsed.phoneNumber };
}

export async function saveLocalProfile(profile: LocalProfile): Promise<void> {
  await profileStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
}
