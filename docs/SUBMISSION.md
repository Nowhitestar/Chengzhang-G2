# Submission notes

Text and a shot list for the DoraHacks submission. Everything here describes what is in this repository.

## Short description

**Chengzhang for Even G2: talk an article into existence, then settle the AI's notes with a tap.**

**The problem.** Ideas arrive when your hands are busy: walking, leaving a meeting, cooking. Typing them later loses them; dictation apps hand you a wall of raw transcript you still have to turn into something.

**Who it is for.** People who write for work or in public (posts, memos, newsletters, documentation) and think better out loud than at a blank page.

**How it works.** Tap the temple and think out loud. The glasses show ink, not words, so you keep thinking instead of editing. When you say "write it up", Claude turns the talking into a draft in your voice and checks the checkable claims on the web. A minute or two later the glasses show the title and one line saying what the article says, plus a short list only you can settle: a sentence the AI added (with its source) to keep or remove, a claim that disagrees with a source to keep or correct, a question to answer out loud. Press and hold to say a change ("make the opening more direct"); undo is one tap away. The finished article is on the phone, typeset, ready to copy as Markdown or send to Notion.

**What makes it a G2 app.** One thing on screen at a time and a few words. Reading is a glance (title and gist); writing back is a tap, the ring, or one spoken sentence. The first item in every list is the safe default. The microphone is on only while you are talking.

**Track.** 04, AI Assistants & Work. Core integration: Claude, through the Anthropic API or OpenRouter (tidying transcripts, web fact-checking, structured-output writing, editing from a spoken instruction). Speech-to-text runs through OpenRouter. Notion is the optional destination.

**Careful with data.** No accounts; a random device token. Audio is deleted once transcribed. An AI-added sentence is deleted by the backend unless its source is a page the fact check actually returned. Nothing you said is changed without you choosing it. No keys in the app.

## Demo video (3 minutes): shot list

Record the simulator window (glasses display and phone page side by side). With real keys set, speak for real; in demo mode the canned example produces the same screens.

| Time | Show | Say (voice-over) |
|---|---|---|
| 0:00 | The opening page: "Think it, say it." | "Ideas come when my hands are busy. This is Chengzhang on Even G2." |
| 0:10 | Tap. Talk for 25 to 30 seconds about something real; ink appears, no words. | "I tap and think out loud. No transcript on screen, so I keep thinking instead of fixing words." |
| 0:45 | Tap. "What you said", cleaned. Choose "Write it up". | "It tidies what I said. Writing starts when I say so, and I can walk away." |
| 1:00 | "Writing": checking the facts, writing it up. Cut ahead. | "Claude checks what can be checked on the web, then writes it in my voice." |
| 1:10 | "Ready": title and gist. Phone page shows the typeset article with highlights. | "One glance: the title and what it says. Three notes are waiting for me." |
| 1:25 | "Check this": leave it or use the correction. One tap. | "Where I disagree with a source, it tells me. It never changes my words silently." |
| 1:40 | "AI added", with source. Keep it. One tap. | "Anything the AI added has a real source. I keep it or remove it." |
| 1:50 | "A question for you". Answer out loud in one sentence. "Changed". | "And it asks what only I know. I answer out loud." |
| 2:10 | "Read it": turn two pages. | "I can read it right here." |
| 2:20 | Press and hold: "make the opening more direct". "Changed", then "Undo" visible. | "Press and hold to say a change. I see what it heard and what it did, and can undo it." |
| 2:40 | Phone page: Copy Markdown (and Send to Notion if configured). | "The article is on my phone, ready to copy or send to Notion." |
| 2:50 | Back to the opening page: "Start a new one". | "From a thought to a draft I decided on, without taking my phone out." |

## Checklist before submitting

- [ ] Run with real keys once and re-record the README pictures if you prefer real content (`npm run e2e` regenerates them in demo mode).
- [ ] Remove the "not verified yet" items in the README that you have since verified (real models, hardware, Notion).
- [ ] Optional: deploy the backend, then `API_ORIGIN=https://… npm run pack` and attach the `.ehpk`.
- [ ] Repository is public; demo video link added on DoraHacks.
