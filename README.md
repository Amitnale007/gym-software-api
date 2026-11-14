# Gym software API

Express and MongoDB API for Superadmin login and gym onboarding. All login accounts, including the initial Superadmin, are stored in MongoDB. Passwords use bcrypt; JWT access and rotating refresh tokens use separate signing secrets. Refresh token hashes are stored in `authsessions` and logout revokes the session.

## Run locally

Use Node.js 22.12+ or Node.js 24 and MongoDB Atlas (or a MongoDB replica set, required for gym creation transactions).

```powershell
npm install
# For a fresh checkout only: copy .env.example to .env and fill in the values.
npm run dev
```

The API listens on `http://127.0.0.1:3000` by default. Run the frontend at `http://localhost:5173`. `FRONTEND_URL` must match the browser origin. Set `VITE_USE_MOCK_API=false` and `VITE_API_URL=http://localhost:3000` in the frontend `.env`, then restart Vite after changing environment variables.

Superadmin accounts live only in MongoDB; no Superadmin email or password is required in `.env` or deployment configuration. Startup does not create or change accounts. Existing database accounts continue to work with their saved passwords.

For a fresh database, run `npm run seed` once and enter the Superadmin name, email, and password at the prompts. Password input is hidden and must contain at least 8 characters. The command saves a bcrypt hash in the `users` collection with role `SUPERADMIN`. Repeating setup for the same email preserves its existing password. For automated setup, the command also accepts a JSON object containing `name`, `email`, and `password` through standard input; keep credentials out of command arguments and source files.

`JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` must be different random values of at least 32 bytes. Defaults for validity are `15m` and `7d`. The optional `DNS_SERVERS` variable accepts comma-separated DNS server addresses if the system resolver refuses Atlas SRV queries; it changes DNS only for this Node process. Leave it blank if the system resolver works.

## Roles and routes

| Role | Access |
| --- | --- |
| `SUPERADMIN` | Sign in, manage subscription plans and gym subscriptions, list and create gyms, view user accounts |
| `GYMADMIN` | Sign in, view their gym, list their gym's users, create customer accounts in their own gym |
| `TRAINER` | View their gym and only their assigned members and membership history |
| `MEMBER` | View their gym and only their own member profile and membership history |

| Method | Endpoint | Access |
| --- | --- | --- |
| POST | `/api/auth/login` | Email and password |
| POST | `/api/auth/refresh-token` | Refresh token; rotated on use |
| POST | `/api/auth/logout` | Bearer access token |
| GET | `/api/auth/me` | Bearer access token |
| GET / POST | `/api/gyms` | Superadmin only |
| GET | `/api/gyms/mine` | Gymadmin or customer; gym determined from their account |
| GET | `/api/users` | Superadmin sees all; Gymadmin sees only their gym |
| POST | `/api/users` | Gymadmin creates a customer in their gym |
| GET / POST | `/api/subscription-plans` | Superadmin lists or creates master plans |
| PATCH | `/api/subscription-plans/:id` | Superadmin edits or activates/deactivates a master plan |
| DELETE | `/api/subscription-plans/:id` | Superadmin removes a plan from future use; existing subscriptions/history remain |
| PATCH | `/api/gyms/:id/subscription` | Superadmin assigns, renews, or cancels a gym subscription |
| GET | `/api/gyms/:id/subscription/history` | Superadmin views the latest 100 changes |

Gym creation accepts `name`, `email`, `phone`, `address`, `city`, `adminName`, `adminEmail`, `adminPassword`, `planId`, and `startsOn` (YYYY-MM-DD). An active master plan is required. Address is optional; the Add Gym form uses one address field and does not ask for city. The API also accepts an optional city for older clients. The administrator password must contain at least 8 characters and fit within bcrypt's 72-byte limit. Gym, Gymadmin, subscription terms, and initial history are committed in one transaction; duplicate login emails are rejected. The caller cannot choose the new administrator's role or override the plan's saved price and validity.

## Subscription master and management

Create a master plan in the Superadmin frontend at `/subscriptions` before creating a gym. Plans accept `name`, `description`, `price` in INR (at most two decimal places), `durationDays` (1–3650), and `isActive`. Prices are stored as integer paise. A price of zero supports a free plan. No default commercial plans or prices are seeded.

The plan master includes search, active/inactive and duration filters, pagination, refresh, and a two-column create/edit dialog. Additional fields are `code` (up to 30 letters, digits, hyphens, or underscores, normalized to uppercase), `pricing` (`FIXED` or `PER_MEMBER`), `pricePerMember` (monthly INR rate, required for per-member pricing). Codes may be shared by plans with different durations. The UI offers 30, 90, 180, and 365-day durations and preserves existing custom day counts. Legacy plans retain fixed pricing and an empty code until edited.

The base price remains in `pricePaise`; the monthly member rate is stored separately as `pricePerMemberPaise`. These are saved plan terms, not a computed invoice or member count. Existing payment processing remains unchanged. Code, pricing mode, and rate are copied into gym subscription/history snapshots, so later master edits cannot alter the saved terms. Attendance services are not part of the subscription plan master.

Removing a plan archives it and marks it inactive. It disappears from plan listings and cannot be assigned, renewed, or edited. Existing gym subscriptions and their history remain available. Archived plan names remain reserved.

Use **Gyms → Manage subscription** for existing gyms, including gyms created before this feature. The API accepts:

```json
{ "action": "assign", "planId": "<active-plan-id>", "startsOn": "2026-11-03", "revision": 0 }
```

For renewal or cancellation, send `action: "renew"` or `action: "cancel"` and the latest `subscriptionRevision` from the gym response. Stale revisions return 409; close the dialog and refresh before retrying. Subscription changes and their history commit together.

Dates use calendar days in Asia/Kolkata, with the expiry day included. A one-day subscription starting November 3 is valid through November 3. Future start dates display Upcoming; elapsed subscriptions display Expired without requiring a background job. Active renewals append a full term after the saved expiry date; expired renewals restart today. Renewal uses the current master price and duration, while previous terms remain in history. Assigning/changing a plan replaces the current subscription immediately. Cancellation is immediate; assign an active plan to reactivate a cancelled subscription.

Editing or deactivating a master plan preserves existing gym terms and history. Inactive plans cannot be newly assigned or renewed. Gymadmins and customers can view their gym's subscription but cannot change it or access the master/history APIs. Subscription status tracks administrative validity; it does not automatically disable gym login, collect payments, or issue refunds. Razorpay charging is not integrated.

Customer creation accepts `name`, `email`, and `password`. Its role and gym are assigned by the server; submitted role or gym overrides are ignored. The compatibility `/api/users` creation route creates a MEMBER login only. Use `/api/members` for complete member profiles and memberships. Payments and live email/password recovery remain outside this implementation. The existing frontend member demo remains available separately through explicit mock mode.

## Verification

```powershell
npm test
```

The 85 integration tests start a disposable MongoDB replica set and do not use `.env` or the Atlas database. They cover authentication, role and gym isolation, gym onboarding transactions, subscription master validation, member pricing, archived plans, price snapshots, assignment, renewal dates, cancellation, inactive plans, history rollback, legacy gyms, concurrent updates, token rotation, logout, trainer-included plans, trainer assignment visibility, and individual member profile access. The first run downloads MongoDB's test binary into the package cache.

Live checks also verified Superadmin login, protected gym listing, subscription master listing, subscription response fields, and logout against the configured Atlas database. Frontend TypeScript and Vite builds and the eight existing mock tests passed. Browser visual verification remains unverified because the earlier Computer Use current-URL check blocked access.

The package audit reports an Express/body-parser compressed-request vulnerability. This API rejects compressed JSON bodies (`inflate: false`); dependency advisory metadata still reports the upstream packages.


## Gym-wise member management

Production uses four roles: `SUPERADMIN`, `GYMADMIN`, `TRAINER`, and `MEMBER`. On API startup, legacy `GYM_CUSTOMER` accounts are migrated to `MEMBER`. Existing logins continue to work. The frontend retains legacy demo roles only in its optional browser demo.

Gym Admin flow: **Member plans ? Add plan ? Trainers ? Add trainer ? Members ? Add member**. Each gym owns its member plan master. These plans are separate from the Superadmin's platform subscription plans. Plans define a name, code, fixed INR membership fee, durationMonths from 1 to 12, optional description, and active status. Names are unique within a gym, not globally. Removing a plan archives it for future use and preserves memberships and history. Archived names stay reserved within that gym.

Member registration requires name, phone, joining date, an active member plan, and a membership start date on or after joining. Email, address, trainer assignment, and login are optional. Enabling login requires an email and password of at least eight characters and at most 72 UTF-8 bytes. Login emails are unique across accounts. Initial passwords are bcrypt hashed and never returned. Login can also be enabled later from Edit Member. Existing login passwords are not reset by profile edits.

Member plans accept a boolean `trainerIncluded`, defaulting to false. The plan editor provides **Trainer included (no extra charge)**; the fixed plan price covers trainer service. Member creation shows the optional trainer selector only for an included plan. Inclusion is snapshotted into the member's membership and history, so plan master edits apply only to future registrations, renewals, and plan changes. Profile edits use saved membership eligibility. Trainer assignments require an active trainer in the same gym; the API rejects assignments for excluded plans even if the client supplies its own eligibility flag.

Renewal and plan changes accept an optional `trainerId`. Eligible renewals retain the existing assignment if this field is omitted; an empty string removes it. Switching to a plan without trainer inclusion clears the assignment in the same transaction as the membership and history change. Legacy memberships with an existing trainer retain assignment eligibility until renewal or plan change applies the current plan terms. After login, trainers land on **My assigned members** and can view only their assigned members and histories; reassignment or removal immediately changes that access. Search, pagination, and dashboard counts use the same trainer scope.

| Method | Endpoint | Access / behavior |
| --- | --- | --- |
| GET / POST | `/api/member-plans` | Gym Admin lists or creates their gym's member plans |
| PATCH / DELETE | `/api/member-plans/:id` | Gym Admin edits or archives their gym's plan |
| GET / POST | `/api/trainers` | Gym Admin lists or creates trainer logins for their gym |
| PATCH | `/api/trainers/:id` | Gym Admin changes trainer `isActive` |
| GET | `/api/members` | Gym Admin: their gym; Trainer: assigned members; Member: own linked profile |
| GET | `/api/members/:id` | Individual profile using the same gym, trainer-assignment, and own-profile access rules |
| POST | `/api/members` | Gym Admin registers a member and optionally a login |
| PATCH | `/api/members/:id` | Gym Admin updates contact details, trainer, active status, or enables login |
| DELETE | `/api/members/:id` | Gym Admin removes a member from the directory and revokes login; requires current revision |
| POST | `/api/members/:id/renew` | Gym Admin renews or changes a member's plan |
| GET | `/api/members/:id/history` | Same gym and profile/assignment visibility as member listing |

All tenant scope comes from the authenticated account; client `gym` and `role` overrides are ignored. Foreign plan/trainer assignments are rejected. Member listing supports `search`, `status`, `planId`, `trainerId`, `page`, and `pageSize`; responses include `meta.pagination`. Status is derived as Active, Upcoming, Expired, or Inactive. Trainers and members cannot modify member profiles or memberships, or access plan administration. Assigned trainers can record and correct fitness assessments as described below.

Registration and optional login creation commit together with the initial history entry. Membership prices, plan names, duration, and dates are snapshotted. Renewals use the current master price and duration. Same-plan renewals are blocked while the current membership is active or scheduled, including its expiry date. After expiry, renewal starts today. Selecting a different plan automatically closes outstanding previous plan records and starts the replacement today, in the same transaction; remaining validity is not transferred. Expiry is inclusive. Profile edits and renewals require the latest member `revision`; concurrent/stale writes return 409. Renewals and their history commit in one transaction.

Deactivating a member disables the linked login and revokes its sessions. Deactivating a trainer revokes sessions and clears their assignments while preserving member profiles. Delete Member soft-deletes the gym-scoped record, clears its trainer, disables its linked login, and revokes sessions atomically. Deleted members are excluded from listings, edits, renewals, and history endpoints; stored membership history remains intact. Deletion requires the latest revision and cannot be performed by Trainers, Members, or another gym. Membership history keeps the latest 100 changes visible. This module records memberships; it does not implement payments, billing, or automated renewal charging. Attendance is implemented separately below.

Tests in `tests/member-management.test.js` use a disposable MongoDB replica set and cover tenant isolation, four roles, optional logins, trainer visibility, snapshots, concurrent renewals, transaction rollback, expired renewals, and deactivation. No production member records or commercial plans are seeded.

Member plan forms offer exactly 1 through 12 calendar months. New terms store durationMonths; old day-based membership snapshots and expiry dates are preserved. Legacy plan masters are displayed using the nearest month count (30 days = 1 month, 90 = 3, 365 = 12), bounded to 1-12, until edited. Month expiry is inclusive: January 15 plus one month expires February 14, January 31 plus one month expires at February month-end. Renewals after expiry add calendar months from today; early same-plan renewal is rejected. Platform subscription plans are unchanged.


## Member ID master

Gym Admins configure their gym's member IDs at `/member-id-settings`. GET/PATCH `/api/member-id-settings` returns or updates `prefix` (1-10 letters, normalized to uppercase), `padding` (1-8 digits), `nextNumber`, and settings `revision`. Default display is `MEM0001`, with no hyphen. Example custom settings: prefix `FIT`, padding `5`, next number `500` produces `FIT00500`.

IDs are stored on each member and remain unchanged after format edits. Sequences are independent per gym and allocated atomically in the member creation transaction, so concurrent registrations cannot receive duplicate numbers and failed registrations do not consume a number. Database indexes enforce gym-wise uniqueness. Deleted numbers and reserved sequence ranges are not reused; the next number can only move forward. Numbers grow beyond the selected padding rather than truncating. Member search also matches the displayed ID.

API startup assigns codes to existing records, including deleted members, in creation order without rewriting memberships, login accounts, or history. The migration is idempotent and preserves any already-issued ID. MongoDB object IDs remain internal identifiers for API paths and references.


## Member-focused dashboard

GET `/api/dashboard/summary` returns live member counts, active/expired/upcoming/inactive membership totals, active memberships expiring today through seven days ahead, new members this calendar month, six monthly joining counts (zero-filled), five recent members, and up to five upcoming renewals. Deleted profiles are excluded. All dates use Asia/Kolkata. Gym Admin receives only their gym; Trainer receives only assigned members; Member receives only their own linked profile. Superadmin continues to use the gym administration screen.

The dashboard shows operational member data, without gym contact or platform subscription details. Gym Admins can view their platform plan at Configuration > Subscription; `/api/gyms/mine` continues to supply that information. No revenue or attendance statistics are fabricated or inferred.

Membership history now returns status, closedOn, and closureReason. Replaced plan records are explicitly Closed, while original validity and price remain unchanged for audit. Legacy older history entries are also displayed as previous/closed records rather than additional active plans. The current member record remains the single source of truth for the active membership.

## Member health and fitness

Fitness assessments are stored separately from memberships, scoped by authenticated gym and member. Gym Admins can record/correct assessments for their gym; Trainers can do so only for currently assigned members. Members can read their own records. Soft-deleted members cannot access fitness endpoints, and stored assessment history is retained.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET | `/api/members/:id/fitness-assessments` | Assessment history ordered by assessment date, then creation date; supports `page` and `pageSize` (5, 10, 25, 50), returns `meta.pagination` |
| GET | `/api/members/:id/fitness-assessments/summary` | Latest and previous assessments plus the latest 100 assessments in chronological order for charts |
| POST | `/api/members/:id/fitness-assessments` | Creates a dated assessment; Gym Admin or assigned Trainer |
| PATCH | `/api/members/:id/fitness-assessments/:assessmentId` | Corrects a record with its current `revision` and a 2–300 character `correctionReason`; stale writes return 409 |

An assessment requires `assessedOn` (YYYY-MM-DD, 2000 through today in India), `heightCm` and `weightKg`. Optional numeric fields are `bodyFatPercent`, `chestCm`, `waistCm`, `leftArmCm`, `rightArmCm`, `leftThighCm`, and `rightThighCm`; omit these or send null when not measured. `notes` allows 1000 characters and `goals` 500. A body fat reading requires `bodyFatMethod`: `bioimpedance`, `skinfold`, `dexa`, or `other`. Without a reading, use an empty method. All numeric inputs are finite, positive and range checked.

BMI is calculated on the server as weight in kg divided by squared height in meters, rounded to one decimal. Client BMI, gym, member and author overrides are ignored. BMI is presented as a screening value without a medical classification. Body fat is a recorded reading rather than a BMI-derived estimate. Corrections atomically preserve previous values, the previous revision, the correcting actor, time and reason in the assessment's `corrections` array. Creating a new assessment never overwrites an older assessment.

`tests/fitness-assessments.test.js` uses a disposable MongoDB replica set to cover calculations, validation, access controls, history pagination, chronological summaries, concurrent corrections, reassignment and retained records after member removal.

## Attendance management

Members check in and check out from their own login using `source: "self"`, or scan the gym QR using `source: "qr"`. The server always selects the profile linked to the authenticated member; supplied member IDs, member codes, gym IDs, actors and timestamps cannot override it. Gym Admins can record exceptions using `source: "manual"` and a member code or ID within their gym. Trainers have read-only access to their assigned members' reports. Superadmins cannot access attendance.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| GET | `/api/attendance/me` | Member's current open visit, membership status, re-entry availability and next allowed check-in time |
| POST | `/api/attendance/punch` | `action` is `check-in` or `check-out`; source is `self`/`qr` for Member, or `manual` for Gym Admin |
| POST | `/api/attendance/qr-code` | Gym Admin creates/loads their gym's stable opaque QR value for display at the gym |
| GET | `/api/attendance` | Daily report with date, status, search and pagination; returns `data.records`, date totals and `meta.pagination` |
| GET | `/api/attendance/activity` | Last-30-day activity, never-visited members, membership status and open visits; supports search, activity filter and pagination |
| GET | `/api/attendance/export` | CSV filename/content for all visits matching the daily report filters (up to 50000) |

Check-in requires an active member with a current membership. Check-out can close an existing visit after membership expiry or deactivation through an admin manual entry. Punch times are server generated; there is no backdating endpoint. A transaction locks the member while processing punches, and a partial unique database index permits at most one open visit. Repeated or simultaneous punches return 409 rather than creating duplicate visits. Re-entry is permitted 60 seconds after checkout. An optional `attendanceId` on checkout prevents a stale request from closing a different visit. Open visits must be checked out before deleting the member; closed attendance is retained in admin reports after deletion.

Daily report dates and displayed/exported times use Asia/Kolkata. Visits overlapping midnight appear on each applicable report date, with durations clipped to that day and current time. Check-ins/check-outs count events on the selected date; members present is a unique-member count for the day. Inside now is a current count independent of the selected date. The report search/status filters affect rows and export, while summary totals cover the full day. Activity uses a rolling 30-day window independently of membership/account status. CSV cells escape user-entered values that could be interpreted as spreadsheet formulas. Each punch records its source and authenticated actor.

`tests/attendance.test.js` covers member identity enforcement, admin-only manual entries, read-only trainers, gym QR validation, simultaneous duplicate punches, cooldowns, membership validity, midnight boundaries, reports, export and activity visibility.
