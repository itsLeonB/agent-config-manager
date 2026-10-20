# 06: Server-side comments

**What to build:** The comments that explain why a counterpart is missing stop living in one
browser and become server-side state, so they survive clearing site data and appear in any
browser on this machine. The behaviour visible in the dashboard does not change: comments are
still attached to items whose counterpart is missing, still appear in the same place, and a
plugin group that is missing on one side still gets one comment input rather than one per
plugin. Editing a comment overwrites the previous text for that item.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] A comment saved in one browser is visible after clearing site data and in a different browser
- [ ] Editing a comment overwrites the previous text for that item rather than creating a second one
- [ ] Comments appear on exactly the same items, and in the same place, as before this change
- [ ] An item with no comment looks identical to before this change
- [ ] An empty comment removes the stored comment rather than storing a blank
