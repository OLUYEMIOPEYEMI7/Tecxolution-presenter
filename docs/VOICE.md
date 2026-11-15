# Voice Detect

Voice Detect listens to the preacher and puts spoken scripture references ("John three sixteen",
"turn to Hebrews chapter eleven verse one") on the screen.

## Two engines

| | Deepgram (recommended) | Browser (free) |
|---|---|---|
| Accuracy | Best — tuned for Bible book names, handles accents well | Fair — Chrome's built-in speech service |
| Works in | Web (any modern browser) **and** the Windows app | Chrome / Edge only |
| Cost | About $0.29 per hour listening (new accounts get $200 free credit) | Free |
| Needs internet | Yes | Yes |

## Setting up Deepgram (once)

1. Create an account at **console.deepgram.com** and create an API key.
2. Control room ▸ **Tools ▸ Voice Detect**: paste the key and press **Save key**.
3. Choose **Deepgram** as the voice engine and press **Start Listening**.

The key is stored **encrypted** on the server and is never sent back to any browser. (Alternatively set the
`DEEPGRAM_API_KEY` environment variable on the server.) In the Windows app the key is stored on that PC.

## Saving credit

Deepgram charges for the time the microphone is streaming. Voice Detect therefore stops by itself after
**10 minutes without any speech**, and after 4 hours in total. Press **Start Listening** again to continue.

## How it works

The browser sends microphone audio (16 kHz mono) to your own server over the existing connection; the server
forwards it to Deepgram and returns the transcript. The key never leaves the server.
