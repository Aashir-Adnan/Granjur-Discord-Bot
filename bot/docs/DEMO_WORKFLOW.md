# Demo Workflow: New User Joining & Using Commands

This document describes a typical flow for a new user joining the server and interacting with the bot's commands.

---

## 1. Join the server

- User receives an invite and joins the Discord server.
- **On join:** The bot assigns the **Holding** role and sends a welcome message in the onboarding channel explaining verification.

---

## 2. Verify

- User runs **`/verify`** in the server.
- Clicks **Request verification code**, enters an allowed email (e.g. `@granjur.com`), and receives a 6-digit code.
- Enters the code in Discord; nickname is set from email and the user remains in **Holding** until approved.

---

## 3. Get approved

- A CEO or Server Manager runs **`/backlog`** or **`/approve`**, selects the new user, assigns roles (e.g. **Verified**, **Senior Dev**), and confirms.
- The user can now access role-locked channels and use commands that require **Verified** or other roles.

---

## 4. Explore commands (after verification)

### Dashboard (CEO / Server Manager)

- **`/dashboard`** — Choose what to view: **Overview**, **Tasks**, **Bugs**, **Features**, **Meetings**, **FAQs**.
- **Tasks** shows all tasks grouped by **module**, with:
  - Type (feature/bug), handler, implementation status
  - API tests, QA tests, acceptance criteria (✓ / ✗ / —)
  - Scope

### Feature ticket

- **`/feature`** — Create a feature task:
  1. Modal: enter **title** and **description**.
  2. Select **repository or project**.
  3. Select **assignees** (who can see the ticket).
  4. Click **Create ticket**.
- A **private channel** is created; only the assigner and assignees can see it.
- A **documentation page** is created with the feature title (content added when the ticket is closed).
- In that channel, when the feature is done: **`/close-feature`** and attach an **MD file** describing the implementation. The ticket is closed and the doc is saved.

### Bug ticket

- **`/bug`** — Create a bug ticket:
  1. Select **repository**.
  2. Modal: **title** and **description**.
  3. Select **members to tag** (assignees).
  4. Click **Create ticket**.
- A **private channel** is created for the assigner and assignees.
- A **documentation page** is created with the bug title.
- In that channel, when the bug is fixed: **`/resolve-bug`** and attach an **MD file** describing the solution. The ticket is resolved and the doc is saved.

### Other commands (examples)

- **`/schedule`** — Schedule a meeting (topic, time, optional invitees).
- **`/project-db`** — View or save project database schema.
- **`/docs`** — Search .md files in repos.
- **`/faq`** — Ask or search FAQs.
- **`/ticket`** — Update bug ticket status (Senior Dev / CEO / Server Manager).
- **`/clock-in`** / **`/clock-out`** — Time tracking.
- **`/fetch-my`** — Fetch your assigned items.

---

## 5. Ticket-only commands

- **`/close-feature`** and **`/resolve-bug`** are **only available in their respective ticket channels**. If used elsewhere, the bot replies that the command must be used inside a feature or bug ticket channel.

---

## 6. Daily reminder

- The bot sends a **DM once per day** to everyone involved in **open** feature or bug tickets, listing their open tickets so they can follow up.

---

## Summary

| Step | Action |
|------|--------|
| 1 | Join server → get Holding role, see onboarding message |
| 2 | **/verify** → email + code → nickname set |
| 3 | **/backlog** or **/approve** (by admin) → roles assigned |
| 4 | Use **/dashboard** (Tasks, Overview, etc.), **/feature**, **/bug**, **/schedule**, **/docs**, **/faq**, etc. |
| 5 | In a feature channel: **/close-feature** + MD file. In a bug channel: **/resolve-bug** + MD file. |
| 6 | Receive daily DM with open ticket reminder |

Tasks in the dashboard are grouped by **module** and show type, handler, implementation status, API/QA/acceptance results, and scope; all fields can be null when not relevant.
