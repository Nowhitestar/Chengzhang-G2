# Privacy

Chengzhang for G2 is the app in this repository plus a backend that you (or whoever gives you the app) run. This page says what each part does with what you say.

## What is collected

| What | Where it goes | How long it is kept |
|---|---|---|
| Your voice, while you are talking to Chengzhang | From the glasses' microphone to the phone, then to the backend in slices of about 15 seconds. The backend sends each slice to the speech-to-text provider it is configured with (OpenRouter by default, or Alibaba Cloud Model Studio). | The backend deletes each slice as soon as it has been transcribed. Only the words are kept. |
| The words you said, and the articles written from them | Stored in the backend's database. Sent to Anthropic's Claude (directly, or through OpenRouter) to be tidied, fact-checked and written up. | Until you delete the article, or the operator deletes the database. |
| A device token | A random token is created the first time the app opens, and stored in the Even Realities app on your phone. It is how the backend knows which articles are yours. | Until the app is uninstalled. |
| Daily counts (minutes of audio, articles written, changes made) | The backend's database, per device. Used only to enforce the daily limits. | Kept with the database. |

There are no accounts, no email addresses, no analytics, and no advertising. The app does not read your location, photos, contacts or other apps' notifications.

## Permissions

- **Glasses microphone** (`g2-microphone`): on only between the moment you start talking and the moment you tap "done" (or let go, when you press and hold). The app never listens in the background.
- **Network** (`network`): the app talks to one address only, the backend it was built for.

## Third parties

What you say is processed by the model providers the backend is configured with: a speech-to-text model (Qwen ASR through OpenRouter or Alibaba Cloud) and Claude (Anthropic, directly or through OpenRouter). The fact check uses Claude's web search. "Send to Notion", when the operator has set it up, creates a page in the operator's Notion workspace. Their own privacy terms apply to what they receive.

## Deleting your data

Deleting an article removes it and its recordings' text from the backend. Uninstalling the app removes the device token; without it the articles can no longer be reached from any device.

## Who runs the backend

Whoever deployed it. If you run this repository yourself, that is you, and your data stays with you and the model providers you chose.
