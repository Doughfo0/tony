# Tony outbound call API

This small server keeps the LiveKit API secret off the Android app. Copy `.env.example` to `.env.local`, fill in the LiveKit and Supabase values, then run:

```sh
npm install
npm start
```

The mobile app sends `POST /api/calls/incoming` with the separate `TONY_CALL_API_TOKEN` and the phone number saved in the app profile when Android reports an incoming call. The server then asks LiveKit SIP to dial that number using `LIVEKIT_SIP_TRUNK_ID`.

The app needs `EXPO_PUBLIC_TONY_API_URL` and `EXPO_PUBLIC_TONY_CALL_API_TOKEN` set before building. Local Expo runs read them from the root `.env.local`; EAS builds need them in the EAS build environment because local environment files are excluded from cloud uploads. For testing from your phone, make the server reachable over HTTPS (for example, deploy it or expose it through an HTTPS tunnel). A public URL is required when the phone is away from your local network.

Create and configure an outbound SIP trunk in LiveKit first. The saved app phone number must be E.164 (for example, `+15551234567`). The app's `EXPO_PUBLIC_TONY_CALL_API_TOKEN` must match the server's `TONY_CALL_API_TOKEN`.

The endpoint accepts up to five outbound requests per source IP per ten minutes and deduplicates repeated call IDs for ten minutes. It does not receive the incoming caller's number or read the device call log. The app token is bundled with the private app build so it can call this server from Android; it is not a LiveKit credential and should not be treated as a secret for a publicly distributed app. Keep the target number fixed on the server and rotate this token if the APK is shared.
