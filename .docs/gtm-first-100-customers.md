# Go-To-Market Strategy: First 100 Paying Customers

Based on analysis of 21 companies: Superhuman, Linear, Figma, Slack, Notion, Calendly, Loom, Todoist, Raycast, ClickUp, Zapier, Monday.com, Airtable, Miro, Basecamp, Vercel, Coda, Campsite, Arc, Craft, Height. Refined through 3 critique iterations.

---

## PRINCIPLE 0: Validate That People Will Do This More Than Once

Voice inbox is a novel category. You are not building a better email client -- you are asking people to adopt a behavior that does not exist. Before any GTM tactic matters, you need evidence that the behavior is repeatable.

Run a validation cohort: concierge onboard 10-15 people from your top 2 ICP candidates (see Principle 1). Walk each person through their first session. Then step back and observe.

What you are measuring: unprompted return rate. An "unprompted return" means the user called the number (or picked up when the product called them) without you texting, emailing, or asking them to. They called because they had email they wanted to handle.

Targets:
- 7-day unprompted return rate above 50%: proceed to scaling.
- 30-50%: the first experience needs redesign, not more users.
- Below 30%: the behavior may not be viable in this form. Rethink the product, not the GTM.

10-15 users is directional, not statistically significant. But at this stage, directional is enough. If the behavior is real, it will be obvious.

## PRINCIPLE 1: Pick Your Beachhead -- Two Segments, Then Commit to One

Your user is defined by a behavior (commuting + email overload), not a job title. But you need to find them by job title because that is how people are reachable. Two highest-potential segments based on problem severity, reachability, and ability to make a $20/month purchase decision without org approval:

**Segment A -- Real estate agents**: In cars constantly (showings, open houses), email-heavy (leads, contracts, scheduling), buy their own tools, reachable via real estate Facebook groups, local broker offices, RE tech communities, and NAR events.

**Segment B -- Field sales reps / account executives**: Driving between client meetings, high email volume, time-sensitive responses needed, reachable via r/sales, sales Slack groups, LinkedIn Sales Navigator, and RevGenius community.

Validation process: Talk to 10 people in each segment. Ask: "Walk me through your last workday -- when you were in the car, what happened with your email?" Listen for workarounds (Siri dictation, pulling over, voice-to-text, calling someone to relay messages). The segment with more existing workarounds is your beachhead.

Commit to one segment after these conversations. Build all messaging, community presence, and outreach around that one segment for the first 100 customers.

## PRINCIPLE 2: Engineer the First 14 Days -- From Onboarding to Habit

This is a single, sequenced pipeline with two phases.

### Phase 1: Concierge onboarding (Day 1-2)
- Schedule a 15-minute walkthrough when the user is about to drive somewhere.
- Connect their email, dial the number together, process 5+ emails by voice while you are available.
- Set up their daily call time (see Phase 2).
- Follow up by text after their first solo session: "How did it go? What felt weird?"

### Phase 2: Habit trigger (Day 3-14)
- The product calls the user at their set commute time. Every day. This is the single most important feature for retention. It transforms the product from "a phone number you can call" to "your inbox calls you when it is time to drive." Push wins for novel behaviors.
- The call opens with a summary: "Good morning. You have 11 new emails. 2 are urgent. Ready to go through them?"
- If the user does not pick up, send an SMS: "Missed your inbox call. You have 11 new emails -- call back when you're ready."

What you are tracking:
- Day 3 pickup rate (do they answer the daily call?)
- Day 7 unprompted return rate (do they call on their own outside scheduled times?)
- Day 14 "would you miss this?" score (ask directly: 1-5, how disappointed would you be if this product disappeared?)

The 14-day unlimited free trial is designed around this pipeline -- long enough to establish a daily habit before the paywall appears. A usage-capped free tier (e.g., 1hr/month) actively prevents habit formation because users hit the wall before the habit solidifies.

## PRINCIPLE 3: Build Trust Before Speed -- Error Recovery Is Existential

Voice AI will make mistakes. It will misread an email, suggest a wrong reply, or misunderstand a command. For a novel product where users are already uncertain, one bad experience ("it sent a weird reply to my client") can kill adoption permanently and generate negative word of mouth that is 10x more powerful than positive.

Design rules for the first version:
- Default to "read and summarize" mode. Do not send any reply without explicit voice confirmation: "I'll send this reply to Sarah: 'Thanks, I'll review it tonight.' Should I send it?"
- Queue sensitive actions (send, delete) for review in the dashboard. Only auto-execute low-risk actions (mark as read, archive, skip).
- When the AI is uncertain, say so: "I'm not sure I understood that. Did you mean reply to Sarah or skip to the next email?"
- After each session, send a text summary of actions taken: "You replied to 3 emails, archived 7, skipped 4. Review or undo any action in the dashboard."

Trust graduation sequence: Start with read-only (list inbox, read emails). Graduate to low-risk actions (archive, mark read). Graduate to high-risk actions (reply, send) only after the user has done 3+ sessions and is comfortable. This is product design, not GTM -- but it determines whether your GTM works.

## PRINCIPLE 4: Founder-Led Direct Outreach to Named Individuals

Once you have your beachhead segment and validated the behavior, build a list of 200 people by name.

How to find them:
- LinkedIn Sales Navigator: filter by job title + geography (metro areas with long commutes)
- Twitter/X search for complaints about email overload in your ICP's context
- ICP-specific communities: post asking "how do you handle email in the car?" and DM people who respond
- Ask your validated users: "Who else at your brokerage / company has this problem?"

Outreach message (adapt to channel):
"I saw [specific thing about them]. I built a product that lets you clear your inbox by voice while you drive -- it calls you at your commute time and walks through your emails. You reply, archive, or skip by talking. Takes 15 minutes to set up. Can I walk you through it this week?"

Math: 200 contacts -> 3-5% response -> 6-10 conversations -> 2-4 activated users per batch. Run 5-6 batches across weeks 4-10. That is 10-24 activated users from outreach, plus referrals.

## PRINCIPLE 5: Ask for Introductions at the Moment of Peak Satisfaction

After a high-quality session (10+ emails processed with fewer than 10% requiring correction), send an automated SMS within 5 minutes:

"You just handled [X] emails in [Y] minutes on your drive. Know anyone else who'd love this? Reply with their name -- you both get a free month."

Why SMS: the user just finished using voice. They are still in "phone mode." SMS is the native follow-up channel.

Why specific numbers: "You handled 14 emails in 12 minutes" is concrete and shareable. It gives the user a story to tell.

Gate the trigger on session quality, not just volume. A user who processed 10 emails but had 3 misunderstandings is not at peak satisfaction.

Target: 20-30% of happy users make at least one introduction. Each introduction is a warm lead with ~30% conversion to trial. This is your primary compounding loop.

## PRINCIPLE 6: Validate Willingness to Pay Before You Scale

Do not assume $20/month works. Test it during the validation cohort.

At day 10 of the 14-day trial, have a personal conversation (call or text) with each user:
- "Your trial ends in 4 days. If this product cost $20/month, would you keep using it?"
- Listen for hesitation. Probe: "What would make it worth $20 to you?"
- If more than 40% say yes without hesitation, the price is right.
- If 20-40% say yes, the product is good but test $10-15.
- If below 20%, you have a value delivery problem, not a pricing problem.

Also test: "Would you pay $20/month to have the product call you every morning with your inbox summary?" vs. "Would you pay $20/month for a number you can call anytime?" The push model may command a premium the pull model does not.

## PRINCIPLE 7: Time Your Public Launch After Retention Is Proven

Do not launch on Product Hunt, pitch press, or do any public marketing until you have:
- 20+ users with 50%+ week-2 retention
- 5+ paying users (past the free trial)
- An onboarding process that works without founder involvement

When those gates are met:

**Product Hunt**: Lead with the novelty angle. "I clear my inbox while driving to work." Film a 60-second demo video. Line up 50+ supporters from your existing users + personal network. If you cannot line up 50, do not launch yet. A weak PH launch is worse than no PH launch.

**Press**: Pitch the story, not the product. "People are managing their entire email inbox by talking to their phone while driving." Target: The Verge's Installer newsletter, Wired, Fast Company, Lenny's Newsletter, productivity-focused podcasters.

**Demo video**: One good video of someone processing emails by voice while driving (safely filmed) is your single most shareable asset. Prioritize creating this before any public launch.

---

## PRIORITY TIMELINE

### Weeks 1-3: Behavior validation
- Talk to 20 people across 2 ICP segments (10 each)
- Pick beachhead segment
- Concierge onboard 10-15 from beachhead
- Implement daily call trigger (product calls user at commute time)
- Measure day-7 unprompted return rate

### Weeks 4-7: Outreach and habit confirmation
- If behavior validated: begin direct outreach (200 named contacts per batch, 5-6 batches total)
- Refine daily call trigger based on pickup rate data
- Measure week-2 retention
- Start asking for introductions from happy users
- Have pricing conversations at day 10 of each user's trial

### Weeks 8-12: Scale what works
- Continue outreach batches, compound introductions
- Build in public on Twitter/LinkedIn (background activity)
- Prepare PH launch and press outreach (only after retention gates met)
- Begin ICP-specific community presence (background activity, not primary channel)
- Implement churn recovery: "We noticed you haven't called this week -- everything OK?" SMS for users who go quiet
- Target: 50-100 users, 20+ paying, by week 12

### Ongoing background
- Film demo content
- Build relationships with 5-10 journalists/newsletter writers
- Track: daily call pickup rate, unprompted return rate, free-to-paid conversion, introduction rate, month-2 retention

---

## FAILURE MODES TO WATCH

1. **Behavior does not stick**: Users try it once and do not call back. Signal: sub-30% day-7 return. Response: redesign the first-call experience before adding more users.

2. **Trust violation**: AI sends a bad reply or misreads an email. Signal: user stops calling after a specific session. Response: review session logs, default to more conservative confirmation modes, personally apologize and offer to review together.

3. **Habit does not form**: Users like it but forget to use it. Signal: high satisfaction scores but low week-2 retention. Response: the daily call trigger is not working. Test different times, different opening summaries, SMS reminders.

4. **Price resistance**: Users love it but will not pay $20/month. Signal: sub-20% trial-to-paid conversion. Response: test lower price points ($10-15) or restructure (annual discount, per-call pricing).

5. **ICP miss**: Your beachhead segment likes it but does not drive enough to need it. Signal: low email volume per session, short sessions. Response: test the other segment before concluding the product does not work.

6. **Month-2 churn**: Users pay for month 1 then stop. Signal: paying users go quiet in weeks 5-8 of use. Response: "win-back" call or SMS, ask what changed. Often the trigger timing drifted or a bad session eroded confidence.

---

## COMPETITIVE MOAT NOTE

If this works, Apple and Google can add "Hey Siri, read my emails" as a native feature. Your defense is: (1) the quality of AI email handling improves with personalization over time (it learns your writing style, your priorities, your contacts), (2) the daily call ritual creates switching costs (users build their morning routine around it), and (3) speed of iteration as a startup vs. platform feature committees. This is not an impenetrable moat -- move fast.

---

## THIS WEEK: GET YOUR FIRST USERS

The principles above are for weeks 1-12. But right now, today:

1. Text 20 people you personally know who commute by car and have heavy email. Individual messages, not a group blast: "Hey [name], I built something that lets you clear your email inbox by voice while you drive. Can I set you up in 10 minutes?"

2. Post on your LinkedIn and Twitter: "Looking for 5 people who commute 30+ min and hate coming back to a full inbox. I'll set you up personally this week. DM me."

3. Post in WhatsApp/Slack groups you are in with founders, sales people, or professionals.

4. Reply to Reddit threads (r/sales, r/realestate, r/productivity) where people complain about email overload or commute productivity.

5. When someone says yes: get on a 10-minute call, connect their email, have them call the number while you are on the line, walk them through 5 emails.

Goal: 3-5 people actively using it this week.
