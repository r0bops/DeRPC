# Research prompt: ETHGlobal pitch, demo video, deck, and what wins

**Author:** Rob (r0bops). The prompt text was drafted by Grok at Rob's request.
**Date:** 2026-11-06
**Tool:** Grok (drafting). The research tool is to be filled in when the prompt is run.
**Files affected:** none yet

## Outcome

Not run yet. When it is, record here which tool ran it and whether the findings were used, changed or rejected. Its findings stay uncited until the team has checked the sources (see `specs/CONTEXT.md` §8). The point of the run is a rules file the team can adopt for the live pitch, the demo video, any deck, and what to build or cut before judging.

## Prompt (verbatim)

```text
Research how ETHGlobal projects are actually judged, and turn that into rules
we can follow. Cover the live pitch, the demo video, and the pitch deck. Cover
winners and finalists, not winners alone. Cover what makes the project itself
good, not only how it is presented. Every claim needs a source I can open.

We will use the result as rules for DeRPC at ETHGlobal Mumbai (November 2026).
DeRPC is a from-scratch, open-source browser provider: Ethereum reads go through
Anon-RPC and Tor, and the user's device checks the answer. That context is only
so you can apply the rules at the end. The evidence has to come from ETHGlobal
and from the public record of that time, not from our notes.

NOTES WE ALREADY HAVE — VERIFY, DO NOT TREAT AS SOURCES
These came from a pasted Mumbai "Key Information" page and from an earlier chat.
Confirm each one on the live page. If the live page disagrees, the live page wins,
and list the disagreement.
- Deadline we are working to: Sat Nov 7, 2026, 09:00 IST. Late submissions are not accepted.
- Finalist session: 7 minutes, a 4-minute demo, then 3 minutes of Q&A.
- Partner prizes are judged from the submission materials. A project may pick up to 3 partners. Presenting at a partner booth is not judging.
- An earlier note, not checked for Mumbai, said most partner prize money goes to projects that never reach the finals. Test that. Do not repeat it unless you can count it.
- Demo video: optional but encouraged, shown on the ETHGlobal Showcase. Between 2 and 4 minutes, at least 720p, not sped up, not recorded on a phone, no text-to-speech or AI voiceover, no music with on-screen text instead of talking. The Ethereum Foundation CROPS prize at this event caps the video at 3 minutes.
- Finalist criteria named on that page: Technicality, Originality, Practicality, Usability (UI/UX/DX), WOW factor.
- From-scratch rule: work starts when the hackathon starts. AI is allowed if the team documents which files and assets it touched, and a project built only by AI can lose partner-prize and finalist eligibility.
- Older projects named on that page as inspiration, not as Mumbai winners: Iris, Splits, Ollie Verse, Cadbury, Umbra, Sunset Supreme, DeFi777, Oya Market. Find which event each won, in which year, and for what. Do not treat them as the current pattern.

WHAT TO SEPARATE
Judging is not one thing. Keep these apart in every finding:
1. ETHGlobal finalist judging (live, short, staff or appointed judges).
2. Partner-prize judging (the sponsor's own criteria, often from the written submission and video, sometimes a booth visit that is not the prize decision).
3. The Showcase video (public, optional at some events, required by some partners).
4. Anything that is advice from a mentor, a blog, or a winner, and was not a published rule.
If a source mixes these, say so.

SCOPE
- ETHGlobal events with a public showcase or a public winners list, from the earliest you can open through Mumbai 2026. Include in-person, online, async, and hybrid events. ETHOnline, Pragma, and hackathons run under another brand are in scope only when the page says ETHGlobal judged them. Say when a rule is from a different organizer.
- You cannot read every project. Use the sample below and say what you did not read.
- For the current event, read the Mumbai pages in full: key information, schedule, judging, prizes, submission form help, and each prize DeRPC might enter (Ethereum Foundation Anon-RPC, Ethereum Foundation CROPS, ENS if its page is public).

SAMPLE — REQUIRED, AND REPORT THE DENOMINATOR
A pattern is a count, not a story. Build one table of projects and cite it whenever you say "winners do X" or "finalists do X".

Minimum sample, all of it from pages you opened:
- At least 8 distinct ETHGlobal events, spread across the years you can open. Include at least 2 events from 2018–2020, 2 from 2021–2023, 2 from 2024–2025, and every 2026 ETHGlobal event whose results or finalist list is public, plus Mumbai's published criteria even if results are not out.
- For each chosen event: every project that won a top finalist prize (1st, 2nd, 3rd, or the event's equivalent), AND at least as many finalists who won no top prize. If the event publishes only winners, say that the finalist half is missing for that event.
- Also, for 4 events, the winners of the largest partner prizes (by published dollar amount). Mark these rows as partner prizes, not finalists.
- For each project row record only what the page shows: event, dates, event format, published theme or tracks, prize and rank, one sentence on what it does, whether a video is linked, video length if shown, whether the page links a repo, and any judge quote attached to that project. Leave a cell blank rather than guessing. Add a column for "what was new in public Ethereum discourse in the 90 days before the event" only when you can tie it to a dated primary source (an EIP, a client release, a foundation post, a partner announcement).

Do not sample only famous projects. Do not drop a finalist because the project looks unimpressive.

FACTORS — CHECK EVERY ONE
For the sample, and again for the official rules, go through this list. For each factor write what the evidence supports, the count it rests on, and "not found" when the pages do not say. Do not skip a factor.

Project
- Does it work in front of the judge, or only in a video, or only as slides?
- Is the demo one path a person can follow, or a tour of features?
- What is the moment that would be visible if the rest were cut?
- How much is new versus a wrapper, a fork, or a template?
- Is there public prior art, including an earlier ETHGlobal project that did the same thing?
- Technical depth a judge can see in the time allowed, versus depth that exists only in the repo.
- Completeness: can a stranger run it from the README after the event?
- User: who it is for, and whether that person appears in the demo.
- Trust and failure: does the demo show the product under a broken dependency, a bad input, or a rejected action?
- Open source, license, and what was reused.
- Team size, if published. Do not infer seniority from a name.
- Commit history and "from scratch", if the rules of that event mention them.
- AI use, if the rules of that event mention it.

Pitch (the live minutes)
- Exact time split published for that event.
- Whether judges want a product demo, a slide narrative, or both.
- How winners and finalists spend the first 20 seconds.
- Whether they show architecture, and for how long, relative to the working product.
- What they leave out.
- The Q&A questions judges actually ask, from ETHGlobal's own pages and from judge or finalist write-ups. Separate "ETHGlobal listed this question" from "a participant said they were asked this".

Video
- Length limits, resolution, audio, voice, music, captions, speed, device, and who must be on camera. Track how these rules changed by event and year.
- What the video spends its time on, when you can watch it: problem, working product, failure case, how to run it, team, ask.
- Partner-specific caps that are stricter than the event cap.
- Whether a video can replace the live demo for finalists. Treat "no" and "not stated" as different.

Deck
- Whether ETHGlobal asks for a pitch deck at all, for finals, for partners, or for the showcase.
- If winners publish decks, what is in them and how many slides.
- If the live judging format has no room for a deck, say that, and then say whether a short leave-behind still helps mentors or partner judges. Do not invent a deck format ETHGlobal does not use.

Judges
- Who judges finals, by role: ETHGlobal staff, independent judges, partners, community. Name people only when a page names them for that event.
- Who judges partner prizes, and whether they are the same people.
- For Mumbai 2026, list every judge, mentor, or partner reviewer the event page names, with their affiliation and which prize or session they are attached to. If the page does not name them, say so.
- Published criteria, weights, and scorecards. Quote them.
- What judges have said in their own posts, talks, and ETHGlobal articles about why a project won or lost. Attribute the person and the date. A judge's taste is not a rule unless ETHGlobal adopted it.
- Conflicts and incentives: a partner judge scoring their own track; prizes for using a sponsor product; prizes for public goods; student or regional prizes. How those change what "good" means.

Theme and the trend of that time
- The event's stated theme, tracks, and partner list.
- What was newly shipping or newly argued in Ethereum in the months before that event, from primary sources, and which winning projects depend on it.
- Which winning ideas were already common at earlier ETHGlobal events, and which were rare before that year.
- What a project would be copying if it repeated a previous year's winning category without a new constraint.

Rules and disqualification
- From-scratch, continuity, and pre-built project rules, and how they differ by event.
- Submission fields that judges see (title, description, repo, video, partner picks, integration explanation).
- Video rejection rules.
- AI, spec-driven development, and attribution rules, including when they started.
- Repo rules: licenses, commit history, single giant commits, secrets.
- What happens if the demo breaks.

QUESTIONS
1. What does ETHGlobal itself tell hackers to do for the live pitch, the video, and any deck? Quote the current Mumbai page and the closest general ETHGlobal help page. Then list the rules that changed across earlier events, with the event and the year.
2. In the sample, what do top finalists show in the minutes they have, and how does that differ from finalists who did not place? Give counts. If you cannot watch the videos, say so and limit the claim to what the showcase text shows.
3. Which partner-prize winners would not have fit the finalist criteria, and the reverse? Count them. Test the claim that a large share of prize money goes to projects that are not finalists. Use published prize amounts. Show the arithmetic and the events you included. If amounts are missing, do not estimate them.
4. What do judges say they reward, in their own words, and where does that differ from the published scorecard? Separate finalist judges from partner judges.
5. For each era in the sample, what kind of project won, what kind of project was a common finalist and did not win, and what was the new technical or product constraint that the winners were responding to? Name the constraint from a dated source.
6. Which showcase projects are the closest prior art to a private or verified Ethereum RPC client, a light client in the browser, an anonymity network for wallet traffic, or an operator directory? For each: event, year, prize if any, and what it did not do. This is so we do not pitch DeRPC as new in a way a judge can contradict.
7. What fails? Collect reasons projects were disqualified, videos were rejected, or judges said a demo did not land. Use only stated reasons. Then list failure modes you infer, labeled as inference, such as too many features, a mocked flow presented as real, a slide story with no product, or a sponsor integration that does not change the app.
8. Deck, decided by evidence. Either ETHGlobal uses a deck in judging, and you describe the decks that were actually used, or it does not, and you say what artifact judges see instead. If you recommend a deck anyway, say who it is for (mentor, partner, finalist backup) and why the sample supports it.
9. Apply the findings to one 4-minute live demo, one video of at most 3 minutes, a Q&A card, and a deck only if question 8 says to have one. The application is for a from-scratch infrastructure tool whose proof is a working failure: a bad answer is rejected, and a dead private network does not fall back to a direct connection. Do not rewrite our product. Say what to show, what to cut, and which claim would be dangerous in front of a judge who has seen the earlier projects from question 6.

HOW TO WORK
- Open the page. Only link pages you opened and read in this session. Do not cite from memory.
- Every finding needs a source and a link next to the claim, not only in a list at the end. This includes dates, prize amounts, time limits, criteria, judge names, and project descriptions.
- Use primary sources first: the event page, the prize page, the showcase project page, the project's repo or README as of the event if you can see it, ETHGlobal's own blog or help center, and a judge's own post or talk. A recap blog is allowed when it quotes a result, and you say it is secondary.
- For each source give the title, the author or organization, the date the page shows, and the direct URL of the page you read, not a search page and not a bare domain. Name the heading the claim comes from and quote the sentence it rests on.
- If you cannot find a source, keep the point and label it "no source found". Do not attach a nearby link to make it look sourced.
- Mark every claim as "read in the source", "counted from the sample", "my inference", or "couldn't verify".
- Do not invent judges, prize amounts, video lengths, or themes. A blank cell is a valid result.
- When you count, show the numerator, the denominator, and which events are in the denominator.
- Describe what a project does from its showcase text. Do not upgrade a hackathon demo into a production system because later marketing says so.
- Trends have to be tied to a dated primary source from that period. "AI was hot" is not a finding. "This EIP was published on this date, and these N winning projects say they implement it" is a finding.
- A winner's postmortem is one person's account. It does not outrank the published rules.

LEADS WORTH CHECKING, NOT A REQUIRED LIST
ETHGlobal's event pages and showcase, including Mumbai 2026 and earlier city and online events; each event's prizes, judging, and key-information pages; ETHGlobal's help or FAQ on submissions and videos; the Showcase pages for the older projects named above; ETHGlobal's blog and YouTube on judging and winning; posts by people the event lists as judges. Confirm every URL. Do not guess an event slug.

WHAT TO RETURN
1. A correction list: each note in "NOTES WE ALREADY HAVE", marked confirmed, contradicted, or not found, with the source.
2. The sample table, including the events you considered and rejected, and why.
3. Official rules, split into live pitch, video, deck, submission, and disqualification. Quote the rule. Official rules outrank patterns.
4. Counted patterns, each with numerator, denominator, events, and the factor from the list above. Keep finalists, winners, and partner-prize winners in separate counts.
5. Judges: a table of named people for Mumbai if published, then a table of what finalist judges and partner judges have said they reward, each line sourced.
6. Era notes: for each event cluster in the sample, the stated theme, the dated technical change you tied to it, what won, and what was common but did not win.
7. Prior art nearest to DeRPC, from question 6.
8. The rules we should adopt. Each rule is one sentence a teammate can follow, then:
   - applies to: pitch, video, deck, Q&A, submission text, or the build
   - rank: official rule, or counted pattern, or inference
   - evidence: the source links and the count
   - counterexample from the sample, or "none in the sample"
   - what would make us drop the rule
   - what DeRPC should do in the next two days because of it
   Put official rules first. If a pattern conflicts with an official rule, keep the official rule and record the conflict. Do not add a rule you cannot attach to a source or a count.
9. The applied script outline: a timed 4-minute live demo, a timed video of at most 3 minutes, and a Q&A card of the questions judges have actually asked plus the questions our criteria imply. A deck outline only if question 8 includes a deck rule. For each minute, say the one thing on screen and the one sentence said.
10. Claims DeRPC must not make, because a judge can check them against the prior art, the rules, or the repo.
11. The full source list: title, author or organization, date, URL, and which findings it supports.
12. Pages you needed and could not open, with the URL and the error.
```
