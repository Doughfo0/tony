import asyncio
from getpass import getpass
from livekit import api

ROOM = "scam-demo"
IDENTITY = "phone-user-15122471893"


async def main():
    url = input("LiveKit project URL: ").strip()
    key = getpass("LiveKit API key (hidden): ").strip()
    secret = getpass("LiveKit API secret (hidden): ").strip()
    trunk = input("Photon outbound trunk ID (ST_...): ").strip()

    if not all([url, key, secret, trunk]):
        raise SystemExit("A required value was empty. Run the script again.")

    client = api.LiveKitAPI(
        url=url,
        api_key=key,
        api_secret=secret,
    )

    try:
        await client.room.create_room(
            api.CreateRoomRequest(name=ROOM)
        )

        participants = await client.room.list_participants(
            api.ListParticipantsRequest(room=ROOM)
        )
        if any(p.identity == IDENTITY for p in participants.participants):
            print("The phone participant is already connected. Not redialing.")
            return

        print("Calling +15122471893 from +16624210306...", flush=True)

        await client.sip.create_sip_participant(
            api.CreateSIPParticipantRequest(
                sip_trunk_id=trunk,
                sip_number="+16624210306",
                sip_call_to="+15122471893",
                room_name=ROOM,
                participant_identity=IDENTITY,
                participant_name="User phone",
                wait_until_answered=True,
            ),
            timeout=90,
        )

        print("Call answered and connected to room scam-demo.")
        print("Hang up on the phone to end the call.")

    finally:
        await client.aclose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nStopped waiting. Check the phone before retrying.")
    except Exception as exc:
        print(f"Call request failed: {exc}")
        print("Check LiveKit call activity before retrying.")
