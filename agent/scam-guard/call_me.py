"""Have Photon call a phone so the user can merge it into an active call."""
import asyncio
import os
import sys
import time

from livekit import api


async def main():
    to = sys.argv[1]                      # e.g. +16267027652
    room = f"protect-{to.lstrip('+')}-{int(time.time())}"
    lk = api.LiveKitAPI()                 # reads LIVEKIT_URL / API_KEY / API_SECRET
    try:
        print(f"Calling {to} into room {room} ...")
        await lk.sip.create_sip_participant(api.CreateSIPParticipantRequest(
            sip_trunk_id=os.environ["LK_OUTBOUND_TRUNK_ID"],
            sip_call_to=to,
            room_name=room,
            participant_identity="protected-user",
            participant_name="Protected user",
            wait_until_answered=True,
        ))
        print("Answered. Now tap MERGE on the phone.")
    finally:
        await lk.aclose()


if __name__ == "__main__":
    asyncio.run(main())
