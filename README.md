# SetSpace Backend API

The SetSpace Backend API provides marketplace data and authenticated
operations for the SetSpace studio-rental application. It is a single-file
Express service backed by MongoDB and the Better Auth session managed by the
frontend application.

## Overview

The API handles studio listings, booking requests, reviews, saved studios,
notifications, profiles, contact messages, and newsletter subscriptions. It
also verifies authenticated requests using the Better Auth session cookie.

All backend implementation is currently in `index.js`.

## Implemented modules

- Public studio listing and detail reads, plus host-owned studio management.
- Studio photos, weekly opening-hours data, and protected host contact lookup.
- Booking creation and authorized booking status transitions.
- Reviews, review eligibility, and studio rating/count updates.
- Wishlists, user notifications, and dashboard statistics.
- User profile reads and updates, including profile image storage.
- Public contact form and newsletter subscription endpoints.
- MongoDB collection/index initialization and a database health check.

Booking requests and status tracking are implemented. The API does not include
a payment gateway.

## Technology stack

- Node.js with ES modules
- Express 5
- MongoDB Node.js driver
- `cors`
- `dotenv`

Direct dependencies and scripts are listed in
[`package.json`](./package.json).

## API reference

Unless noted otherwise, marketplace endpoints return JSON. New marketplace
routes use `{ "success": true, "message": "...", "data": ... }` on success.
Profile endpoints retain their profile-specific response shapes.

### Service and public endpoints

| Method | Endpoint | Purpose | Authentication |
| --- | --- | --- | --- |
| `GET` | `/` | Basic service response (`Hello World!`). | Public |
| `GET` | `/api/health` | Checks both databases and required application collections. | Public |
| `GET` | `/api/studios` | Lists published/active studios. | Public |
| `GET` | `/api/studios/:id` | Reads a published/active studio. | Public |
| `GET` | `/api/studios/:id/photos/:index` | Serves a stored studio photo. Private listing photos are restricted to the owner. | Conditional |
| `GET` | `/api/reviews?studioId=:id` | Lists reviews, optionally filtered by studio. | Public |
| `POST` | `/api/contact` | Saves a contact message. | Public |
| `POST` | `/api/newsletter` | Subscribes an email address. | Public |

### Studios

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/studios/mine` | Lists the signed-in host's studios, including drafts. |
| `GET` | `/api/studios/mine/:id` | Reads one studio owned by the signed-in host. |
| `POST` | `/api/studios` | Creates a studio. Accepts `details` and a `draft` or `published` status. |
| `PATCH` | `/api/studios/:id` | Updates an owned studio. |
| `PATCH` | `/api/studios/:id/status` | Changes an owned studio's `draft`/`published` status. |
| `DELETE` | `/api/studios/:id` | Deletes an owned studio. |
| `GET` | `/api/studios/:id/contact` | Returns the host phone number for a published studio. |

All routes in this section require a valid session and enforce studio
ownership where applicable.

### Bookings

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/bookings?role=renter\|host` | Lists the signed-in user's bookings; `role` is optional. |
| `POST` | `/api/bookings` | Creates a booking request for a published studio. |
| `PATCH` | `/api/bookings/:id/status` | Applies an authorized booking status transition. |

Example request:

```json
{
  "studioId": "STUDIO_OBJECT_ID",
  "bookingDate": "2026-12-01",
  "startTime": "10:00",
  "endTime": "13:00",
  "guests": 2
}
```

The server determines the renter from the verified session and validates
availability and booking conflicts.

### Reviews

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/reviews/eligibility?studioId=:id` | Checks whether the signed-in renter can review a completed booking. |
| `POST` | `/api/reviews` | Submits a review for an eligible completed booking. |

Review creation requires a completed, ended booking associated with the
session user. The studio rating and review count are updated with the review.

### Wishlists, statistics, and notifications

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/stats` | Returns renter and host dashboard statistics. |
| `GET` | `/api/wishlists` | Lists the signed-in user's saved published studios. |
| `POST` | `/api/wishlists` | Saves a published studio. |
| `DELETE` | `/api/wishlists/:studioId` | Removes a studio from the wishlist. |
| `GET` | `/api/notifications` | Lists the signed-in user's notifications. |
| `PATCH` | `/api/notifications/read-all` | Marks all notifications as read. |
| `PATCH` | `/api/notifications/:id/read` | Marks one notification as read. |
| `DELETE` | `/api/notifications/:id` | Deletes one notification. |

### Profiles and user account

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/profile` | Reads the signed-in user's profile, Better Auth user, and profile stats. |
| `POST` | `/api/profile` | Creates the profile if one does not already exist. |
| `PATCH` / `PUT` | `/api/profile` | Updates the signed-in user's profile. |
| `DELETE` | `/api/profile` | Deletes the SetSpace profile document. |
| `DELETE` | `/api/profile/fields/:field` | Clears an allowed editable profile field. |
| `GET` | `/api/profile/image` | Serves the signed-in user's profile image. |
| `PUT` | `/api/profile/image` | Saves a supported raw image upload. |
| `GET` | `/users/:id` | Reads the signed-in user's Better Auth account; `/users/me` is supported. |

Profile endpoints use their established response shape, such as
`{ "profile": ..., "user": ..., "stats": ... }`; profile errors include
`error` and `code`. The server derives user identity from the session rather
than trusting a request-body user ID.

Unknown routes return `404` with a JSON error response.

## Authentication and authorization

The frontend runs Better Auth at `/api/auth/*`. For protected API requests,
the backend forwards the incoming session cookie to the Better Auth
`/api/auth/get-session` endpoint and uses the returned user ID for
authorization. The frontend and backend must agree on the Better Auth base
URL and use the same session/auth database.

Protected routes validate ownership for studio, booking, profile, wishlist,
and notification operations. Public studio and review reads do not require a
session; host contact lookup and mutations do.

## MongoDB architecture

Both applications use the same MongoDB cluster, with separate databases for
authentication and marketplace data:

| Database | Owner and contents |
| --- | --- |
| `auth` (lowercase) | Better Auth owns `user`, `session`, `account`, and `verification`. The API reads the user collection for account responses and does not modify Better Auth records. |
| `SetSpace` | Marketplace collections: `userProfiles`, `studios`, `bookings`, `reviews`, `wishlists`, `notifications`, `contactMessages`, and `newsletterSubscribers`. |

The database is named `auth` in the current frontend auth configuration.
Although it may be referred to conceptually as the Auth database, it is
lowercase in MongoDB; changing it independently would disconnect the API from
Better Auth. The backend ensures the application collections and indexes
exist at startup.

## Repository structure

```text
index.js          Express app, MongoDB setup, middleware, helpers, and routes
package.json      Dependencies and npm scripts
package-lock.json Locked dependency versions
.gitignore        Ignores local dependencies and environment configuration
```

## Environment variables

Create a `.env` file in the backend repository root. Never commit credentials.

```dotenv
PORT=5000
MONGODB_USERNAME=YOUR_MONGODB_USERNAME
MONGODB_PASSWORD=YOUR_MONGODB_PASSWORD

# Comma-separated frontend origins allowed by CORS
CLIENT_URI=http://localhost:3000

# Base URL of the Next.js app running Better Auth
BETTER_AUTH_URL=http://localhost:3000

# Defaults shown for clarity; keep AUTH_DB_NAME aligned with the frontend.
AUTH_DB_NAME=auth
SETSPACE_DB_NAME=SetSpace

# Optional fallback for resolving the Better Auth base URL when
# BETTER_AUTH_URL is not set.
# AUTH_JWKS_URL=http://localhost:3000/api/auth/jwks
```

`MONGODB_USERNAME` and `MONGODB_PASSWORD` are used for the current Atlas
cluster. `MONGODB_URI` is used as a fallback when credentials are not set. The current backend
constructs its MongoDB connection from these credentials; it does not read a
`MONGODB_URI` variable. `PORT`, `CLIENT_URI`, `BETTER_AUTH_URL`,
`AUTH_DB_NAME`, and `SETSPACE_DB_NAME` have code defaults. If changing
`AUTH_DB_NAME`, update the frontend Better Auth database configuration too.

## Installation and local development

```bash
npm install
npm run dev
```

The development script runs `node --watch index.js`. The API listens on port
`5000` by default and requires network access to MongoDB and the configured
Next.js Better Auth endpoint.

## API usage

Public studio listing:

```bash
curl http://localhost:5000/api/studios
```

Health check:

```bash
curl http://localhost:5000/api/health
```

Authenticated requests must include the Better Auth session cookie issued by
the frontend. For browser requests, configure the frontend API base URL and
allow its origin through `CLIENT_URI`.

## Production deployment

Run the service with:

```bash
node index.js
```

Configure the deployment environment with MongoDB credentials, the platform's
`PORT`, the production frontend origin(s) in `CLIENT_URI`, and the frontend
Better Auth base URL in `BETTER_AUTH_URL`. Ensure the API can reach both
MongoDB and the deployed Next.js authentication endpoint. Configure the
frontend's `NEXT_PUBLIC_API_URL` to the deployed API base URL and use HTTPS
origins in production.

No automated test suite is configured yet; the `test` script in
`package.json` is a placeholder.

## Project links

- Backend Repository: `YOUR_BACKEND_GITHUB_REPOSITORY_URL`
- Frontend Repository: `YOUR_FRONTEND_GITHUB_REPOSITORY_URL`
- Live Backend API: `YOUR_LIVE_BACKEND_API_URL`

## License

The backend `package.json` declares the ISC license. This repository does not
currently include a separate `LICENSE` file.
