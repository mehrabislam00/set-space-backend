import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const app = express();
const port = Number(process.env.PORT) || 5000;

/* ------------------------------------------------------------------ */
/* 1. Configuration                                                    */
/* ------------------------------------------------------------------ */

const username = process.env.MONGODB_USERNAME;
const password = process.env.MONGODB_PASSWORD;
let resolvedMongoUri = process.env.MONGODB_URI?.trim();

if (username && password) {
  // Prefer the deployed credential pair because it keeps the known Atlas
  // cluster and avoids stale or placeholder MONGODB_URI values.
  resolvedMongoUri = `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@ac-tikzacb-shard-00-00.rbwczib.mongodb.net:27017,ac-tikzacb-shard-00-01.rbwczib.mongodb.net:27017,ac-tikzacb-shard-00-02.rbwczib.mongodb.net:27017/?ssl=true&replicaSet=atlas-11uhlz-shard-0&authSource=admin`;
}

if (!resolvedMongoUri) {
  throw new Error(
    'MONGODB_URI or MONGODB_USERNAME and MONGODB_PASSWORD must be configured',
  );
}

const AUTH_DB_NAME = process.env.AUTH_DB_NAME?.trim() || 'auth';
const SETSPACE_DB_NAME = process.env.SETSPACE_DB_NAME?.trim() || 'SetSpace';
const USER_PROFILES_COLLECTION = 'userProfiles';
const PROFILE_BIO_MAX = 280;
const PROFILE_IMAGE_MAX_BYTES = 1_048_576;
const CONTACT_NAME_MAX_LENGTH = 100;
const CONTACT_EMAIL_MAX_LENGTH = 254;
const CONTACT_TOPIC_MAX_LENGTH = 120;
const CONTACT_MESSAGE_MAX_LENGTH = 5000;
const PROFILE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml']);
const STUDIO_PHOTO_MAX_BYTES = PROFILE_IMAGE_MAX_BYTES;
const STUDIO_PHOTO_MAX_COUNT = 8;
const STUDIO_PHOTO_TYPES = PROFILE_IMAGE_TYPES;
const MAX_STUDIO_PHOTO_DATA_URL_LENGTH = Math.ceil(STUDIO_PHOTO_MAX_BYTES / 3) * 4 + 128;
const BOOKING_SERVICE_FEE_RATE = 0.08;
const REVIEW_COMMENT_MAX_LENGTH = 2000;
const BOOKING_OVERLAP_STATUSES = ['Pending', 'Confirmed'];
const BOOKING_STATUSES = new Set(['Pending', 'Confirmed', 'Rejected', 'Completed', 'Cancelled']);
const STUDIO_CATEGORIES = new Set([
  'Photo Studios',
  'Music Studios',
  'Podcast Studios',
  'Film Studios',
  'Content Creation Studios',
  'Art Studios',
]);
const STUDIO_CATEGORY_LABELS = {
  'Photo Studios': 'Photo Studio',
  'Music Studios': 'Music Suite',
  'Podcast Studios': 'Podcast Room',
  'Film Studios': 'Film Stage',
  'Content Creation Studios': 'Content Studio',
  'Art Studios': 'Art Workshop',
};
const STUDIO_CATEGORY_DISCIPLINES = {
  'Photo Studios': 'Photo Studios',
  'Music Studios': 'Music Suites',
  'Podcast Studios': 'Podcast Rooms',
  'Film Studios': 'Film Stages',
  'Content Creation Studios': 'Content Studios',
  'Art Studios': 'Art Workshops',
};

/**
 * The browser never talks to this API with a user id. Every profile request
 * is authorised by the Better Auth session cookie, which is forwarded to the
 * Better Auth handler running in the Next.js app.
 *
 * BETTER_AUTH_URL is preferred. AUTH_JWKS_URL is accepted as a fallback
 * because it is already present in the backend environment and points at
 * Better Auth (`http://localhost:3000/api/auth/jwks`).
 */
function resolveAuthBaseUrl() {
  const explicit = process.env.BETTER_AUTH_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, '');

  const jwksUrl = process.env.AUTH_JWKS_URL?.trim();
  if (jwksUrl) {
    const base = jwksUrl.replace(/\/api\/auth\/jwks\/?$/, '');
    if (base && base !== jwksUrl) return base.replace(/\/+$/, '');
  }

  const clientUri = process.env.CLIENT_URI?.split(',')[0]?.trim();
  return (clientUri || 'http://localhost:3000').replace(/\/+$/, '');
}

const AUTH_BASE_URL = resolveAuthBaseUrl();
const SESSION_ENDPOINT = `${AUTH_BASE_URL}/api/auth/get-session`;

function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

// Better Auth validates Origin on cookie-bearing requests. Use the trusted
// frontend origin that Better Auth itself is configured with.
const AUTH_ORIGIN = getOrigin(AUTH_BASE_URL);

const allowedOrigins = (process.env.CLIENT_URI || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',')
  .map((origin) => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/* ------------------------------------------------------------------ */
/* 2. Express middleware                                               */
/* ------------------------------------------------------------------ */

app.disable('x-powered-by');

app.use(
  cors({
    origin(origin, callback) {
      // Requests without an Origin header (curl, server-to-server) are allowed.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept'],
    optionsSuccessStatus: 204,
  }),
);

// CORS only controls browser response headers. Reject a disallowed Origin
// outright as well so a state-changing request cannot be processed.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    return res.status(403).json({
      error: 'Origin not allowed',
      code: 'ORIGIN_NOT_ALLOWED',
    });
  }

  next();
});

app.use(
  express.json({
    limit: '100kb',
    type: (req) =>
      !req.path.startsWith('/api/studios') &&
      req.path !== '/api/profile/image',
  }),
);

const parseStudioJsonBody = express.json({ limit: '12mb' });

function handleStudioJsonBody(req, res, next) {
  parseStudioJsonBody(req, res, (error) => {
    if (!error) return next();

    if (error.type === 'entity.too.large') {
      return sendError(res, 413, 'Studio listing data exceeds the size limit');
    }

    if (error.type === 'entity.parse.failed') {
      return sendError(res, 400, 'Could not read the studio listing');
    }

    return next(error);
  });
}

const parseProfileImageBody = express.raw({
  type: () => true,
  limit: PROFILE_IMAGE_MAX_BYTES,
});

function handleProfileImageBody(req, res, next) {
  parseProfileImageBody(req, res, (error) => {
    if (!error) return next();

    if (error.type === 'entity.too.large') {
      return res.status(413).json({
        error: 'Profile image must be 1 MB or smaller',
        code: 'PROFILE_IMAGE_TOO_LARGE',
      });
    }

    if (error.type === 'encoding.unsupported') {
      return res.status(415).json({
        error: 'Unsupported profile image encoding',
        code: 'UNSUPPORTED_PROFILE_IMAGE_ENCODING',
      });
    }

    if (error.type === 'entity.parse.failed') {
      return res.status(400).json({
        error: 'Could not read the uploaded profile image',
        code: 'INVALID_PROFILE_IMAGE_BODY',
      });
    }

    return next(error);
  });
}

/* ------------------------------------------------------------------ */
/* 3. MongoDB connection                                               */
/* ------------------------------------------------------------------ */

const client = new MongoClient(resolvedMongoUri, {
  serverSelectionTimeoutMS: 10_000,
});

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log('You successfully connected to MongoDB!');
    return client;
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err);
    throw err;
  }
}

let setSpaceDb = null;
let authDb = null;

/**
 * Application collections live only in SetSpace. Better Auth owns `user`,
 * `session`, `account` and `verification` inside the auth database; this
 * process reads `user` and never creates or reshapes those collections.
 *
 * The database name stays `auth` (lowercase) because lib/auth.ts opens
 * client.db("auth"). A separate `Auth` database would split login data
 * away from the adapter Better Auth is already using.
 */
const APPLICATION_COLLECTIONS = [
  USER_PROFILES_COLLECTION,
  'studios',
  'bookings',
  'reviews',
  'wishlists',
  'notifications',
  'contactMessages',
  'newsletterSubscribers',
];

let userProfiles = null;
let studios = null;
let bookings = null;
let reviews = null;
let wishlists = null;
let notifications = null;
let contactMessages = null;
let newsletterSubscribers = null;

// Better Auth data (auth database). Read-only here: Better Auth owns it.
let authUsers = null;

/** True only for a 24-character hex ObjectId string. */
function isValidObjectId(value) {
  if (typeof value !== 'string' || !ObjectId.isValid(value)) return false;
  return String(new ObjectId(value)) === value;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function isValidEmail(value) {
  return (
    typeof value === 'string' &&
    value.length <= CONTACT_EMAIL_MAX_LENGTH &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  );
}

function normalizeContactPhone(value) {
  if (typeof value !== 'string') return null;

  const phone = value.trim().replace(/[\s().-]/g, '');
  if (!/^\+?\d+$/.test(phone)) return null;

  const digits = phone.startsWith('+') ? phone.slice(1) : phone;
  if (/^01[3-9]\d{8}$/.test(digits)) {
    return `+880${digits.slice(1)}`;
  }
  if (/^0[2-9]\d{7,9}$/.test(digits)) {
    return `+880${digits.slice(1)}`;
  }
  if (/^8801[3-9]\d{8}$/.test(digits)) {
    return `+${digits}`;
  }
  if (/^880\d{8,10}$/.test(digits)) {
    return `+${digits}`;
  }
  if (phone.startsWith('+') && /^[1-9]\d{6,14}$/.test(digits)) {
    return `+${digits}`;
  }
  return null;
}

function sendSuccess(res, { status = 200, message, data } = {}) {
  const body = { success: true };
  if (message) body.message = message;
  if (data !== undefined) body.data = data;
  return res.status(status).json(body);
}

function sendError(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function withApiErrorHandling(handler, message, { logMessage, onError } = {}) {
  return (req, res) =>
    handler(req, res).catch((error) => {
      if (onError) return onError(error, req, res);
      console.error(logMessage || `${message}:`, error);
      return sendError(res, 500, message);
    });
}

function withStudioErrorHandling(handler, message) {
  return withApiErrorHandling(handler, message, {
    onError(error, _req, res) {
      if (error?.status === 400) {
        return sendError(res, 400, error.message);
      }

      console.error(`${message}:`, error);
      return sendError(res, 500, message);
    },
  });
}

function withBookingErrorHandling(handler, message, duplicateMessage) {
  return withApiErrorHandling(handler, message, {
    onError(error, _req, res) {
      if (error?.status) {
        return sendError(res, error.status, error.message);
      }
      if (duplicateMessage && error?.code === 11000) {
        return sendError(res, 409, duplicateMessage);
      }

      console.error(`${message}:`, error);
      return sendError(res, 500, message);
    },
  });
}

function findProfile(userId) {
  return userProfiles.findOne({ userId }, { projection: { imageData: 0 } });
}

async function getHostOnboardingState(userId) {
  const [
    profile,
    hostedStudioCount,
    publishedStudioCount,
    bookingCount,
    resolvedBookingCount,
    updatedStudioCount,
  ] = await Promise.all([
    findProfile(userId),
    studios.countDocuments({ ownerId: userId }),
    studios.countDocuments({
      ownerId: userId,
      status: { $in: ['active', 'published'] },
    }),
    bookings.countDocuments({ ownerId: userId }),
    bookings.countDocuments({
      ownerId: userId,
      status: { $in: ['Confirmed', 'Rejected', 'Completed'] },
    }),
    studios.countDocuments({
      ownerId: userId,
      $expr: { $gt: ['$updatedAt', '$createdAt'] },
    }),
  ]);
  const name =
    typeof profile?.name === 'string'
      ? profile.name.trim().replace(/\s+/g, ' ')
      : '';
  const profileComplete = name.length > 0 && name.length <= PROFILE_LIMITS.name;
  const completedSteps = [1];
  if (profileComplete) completedSteps.push(2);
  if (profileComplete && hostedStudioCount > 0) completedSteps.push(3);
  if (hostedStudioCount > 0 && publishedStudioCount > 0) completedSteps.push(4);
  if (publishedStudioCount > 0 && bookingCount > 0) completedSteps.push(5);
  if (bookingCount > 0 && resolvedBookingCount > 0) completedSteps.push(6);
  if (hostedStudioCount > 0 && updatedStudioCount > 0) completedSteps.push(7);
  if (hostedStudioCount > 0) completedSteps.push(8);
  const savedStep = profile?.hostOnboardingStep;
  const currentStep =
    Number.isInteger(savedStep) && savedStep >= 0 && savedStep < 8
      ? savedStep
      : 0;

  return {
    onboardingCompleted: profile?.hostOnboardingCompleted === true,
    hasHostedStudio: hostedStudioCount > 0,
    profileComplete,
    missingFields: profileComplete ? [] : ['name'],
    currentStep,
    completedSteps,
  };
}

function sendProfileError(res, status, message, code, details = {}) {
  return res.status(status).json({ error: message, ...details, code });
}

function logProfileError(res, error, logMessage, message, code) {
  console.error(logMessage, error);
  return sendProfileError(res, 500, message, code);
}

function withProfileErrorHandling(handler, logMessage, message, code) {
  return (req, res) =>
    handler(req, res).catch((error) => logProfileError(res, error, logMessage, message, code));
}

/**
 * Create a collection only when it is missing. Existing documents, including
 * userProfiles written by the profile API, are left in place.
 */
async function ensureApplicationCollections() {
  const existing = new Set(
    (await setSpaceDb.listCollections({}, { nameOnly: true }).toArray()).map(
      (collection) => collection.name,
    ),
  );

  for (const name of APPLICATION_COLLECTIONS) {
    if (!existing.has(name)) {
      await setSpaceDb.createCollection(name);
    }
  }
}

/**
 * Indexes that later modules rely on. createIndex is idempotent when the
 * same key and options already exist.
 */
async function createIndex(collection, keys, options) {
  try {
    await collection.createIndex(keys, options);
  } catch (error) {
    // 85/86: an equivalent index already exists under another name.
    if (error?.code === 85 || error?.code === 86) {
      console.warn(
        `Index already present on ${collection.collectionName}:`,
        options?.name || JSON.stringify(keys),
      );
      return;
    }

    throw error;
  }
}

async function ensureApplicationIndexes() {
  const indexes = [
    [userProfiles, { userId: 1 }, { unique: true, name: 'userId_unique' }],
    [
      studios,
      { slug: 1 },
      { unique: true, name: 'slug_unique', partialFilterExpression: { slug: { $gt: '' } } },
    ],
    [studios, { ownerId: 1 }, { name: 'ownerId' }],
    [studios, { status: 1 }, { name: 'status' }],
    [studios, { status: 1, featured: 1, createdAt: -1 }, { name: 'status_featured_createdAt' }],
    [bookings, { renterId: 1, createdAt: -1 }, { name: 'renterId_createdAt' }],
    [bookings, { ownerId: 1, createdAt: -1 }, { name: 'ownerId_createdAt' }],
    [bookings, { studioId: 1, bookingDate: 1, status: 1 }, { name: 'studioId_bookingDate_status' }],
    [reviews, { studioId: 1, createdAt: -1 }, { name: 'studioId_createdAt' }],
    [reviews, { userId: 1, createdAt: -1 }, { name: 'userId_createdAt' }],
    [
      reviews,
      { bookingId: 1 },
      {
        unique: true,
        name: 'bookingId_unique',
        partialFilterExpression: { bookingId: { $gt: '' } },
      },
    ],
    [wishlists, { userId: 1 }, { unique: true, name: 'userId_unique' }],
    [notifications, { userId: 1, createdAt: -1 }, { name: 'userId_createdAt' }],
    [notifications, { userId: 1, isRead: 1, createdAt: -1 }, { name: 'userId_isRead_createdAt' }],
    [contactMessages, { createdAt: -1 }, { name: 'createdAt' }],
    [contactMessages, { status: 1, createdAt: -1 }, { name: 'status_createdAt' }],
    [newsletterSubscribers, { email: 1 }, { unique: true, name: 'email_unique' }],
  ];

  await Promise.all(
    indexes.map(([collection, keys, options]) => createIndex(collection, keys, options)),
  );
}

const STALE_INDEXES = {
  studios: ['slug_1', 'category_1', 'city_1'],
  reviews: ['bookingId_1'],
  wishlists: ['userId_1_studioId_1'],
  bookings: ['hostId_1', 'renterId_1', 'studioId_1'],
};

/**
 * Earlier experiments left indexes for a different document shape: a required
 * slug on every studio, hostId instead of ownerId, and one wishlist row per
 * studio. The collections are application-owned and these names are not part
 * of the current index set, so they are removed before the real indexes are
 * ensured. Auth indexes are never touched.
 */
async function retireStaleIndexes() {
  for (const [name, indexNames] of Object.entries(STALE_INDEXES)) {
    const collection = setSpaceDb.collection(name);
    const existing = new Set((await collection.indexes()).map((index) => index.name));

    for (const indexName of indexNames) {
      if (!existing.has(indexName)) continue;
      await collection.dropIndex(indexName);
      console.log(`Dropped stale index ${name}.${indexName}`);
    }
  }
}

let databaseReady = false;
let mongoInitializationPromise = null;

async function setupDatabases() {
  const [authPing, setSpacePing] = await Promise.all([
    authDb.command({ ping: 1 }),
    setSpaceDb.command({ ping: 1 }),
  ]);

  if (authPing?.ok !== 1 || setSpacePing?.ok !== 1) {
    throw new Error('MongoDB ping did not succeed for both databases');
  }

  await ensureApplicationCollections();
  await retireStaleIndexes();
  await ensureApplicationIndexes();
  databaseReady = true;

  const [authNames, setSpaceNames] = await Promise.all([
    authDb.listCollections({}, { nameOnly: true }).toArray(),
    setSpaceDb.listCollections({}, { nameOnly: true }).toArray(),
  ]);

  console.log(
    `Auth database "${AUTH_DB_NAME}" is reachable. Collections: ${
      authNames.map((collection) => collection.name).join(', ') || '(none yet)'
    }`,
  );
  console.log(
    `SetSpace database "${SETSPACE_DB_NAME}" is reachable. Collections: ${setSpaceNames
      .map((collection) => collection.name)
      .join(', ')}`,
  );
}

export async function ensureMongoReady() {
  if (databaseReady) return client;

  if (!mongoInitializationPromise) {
    mongoInitializationPromise = (async () => {
      const connectedClient = await connectToMongoDB();
      setSpaceDb = connectedClient.db(SETSPACE_DB_NAME);
      authDb = connectedClient.db(AUTH_DB_NAME);
      authUsers = authDb.collection('user');

      userProfiles = setSpaceDb.collection(USER_PROFILES_COLLECTION);
      studios = setSpaceDb.collection('studios');
      bookings = setSpaceDb.collection('bookings');
      reviews = setSpaceDb.collection('reviews');
      wishlists = setSpaceDb.collection('wishlists');
      notifications = setSpaceDb.collection('notifications');
      contactMessages = setSpaceDb.collection('contactMessages');
      newsletterSubscribers = setSpaceDb.collection('newsletterSubscribers');

      await setupDatabases();
      return connectedClient;
    })().catch((error) => {
      mongoInitializationPromise = null;
      console.error(
        'Database foundation setup failed:',
        error?.message || 'Database setup failed',
      );
      throw error;
    });
  }

  return mongoInitializationPromise;
}

void ensureMongoReady().catch(() => {});

/* ------------------------------------------------------------------ */
/* 4. Authentication                                                   */
/* ------------------------------------------------------------------ */

/**
 * Ask the Better Auth server who owns the incoming cookies. This reuses the
 * existing Next.js Better Auth configuration (secret, cookie names, adapter)
 * instead of maintaining a second copy of the auth setup in this service.
 */
async function getBetterAuthSession(req) {
  if (!req.headers.cookie) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const headers = {
      accept: 'application/json',
      origin: AUTH_ORIGIN,
    };

    headers.cookie = req.headers.cookie;

    const response = await fetch(SESSION_ENDPOINT, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Better Auth session endpoint returned ${response.status}`);
    }

    const data = await response.json().catch(() => null);

    if (!data?.user?.id) {
      return null;
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/** Reject the request unless it carries a verified Better Auth session. */
async function requireSession(req, res, next) {
  try {
    const session = await getBetterAuthSession(req);

    if (!session) {
      return res.status(401).json({
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
    }

    req.authUser = session.user;
    req.userId = String(session.user.id);

    next();
  } catch (error) {
    console.error('Session verification failed:', error?.message || error);

    return res.status(503).json({
      error: 'Authentication service is unavailable',
      code: 'AUTH_UNAVAILABLE',
    });
  }
}

/* ------------------------------------------------------------------ */
/* 5. Profile helpers                                                  */
/* ------------------------------------------------------------------ */

const DELETABLE_FIELDS = new Set(['phone', 'location', 'bio', 'image']);
const PROFILE_LIMITS = {
  name: 80,
  phone: 20,
  location: 120,
  bio: PROFILE_BIO_MAX,
  image: 2048,
};

function cleanText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nameFromSession(user) {
  const name = cleanText(user?.name);
  if (name) return name;

  const email = cleanText(user?.email);
  return email ? email.split('@')[0] : 'SetSpace user';
}

function serializeUser(user) {
  return {
    id: String(user.id),
    name: user.name ?? '',
    email: user.email ?? '',
    image: user.image ?? null,
    emailVerified: Boolean(user.emailVerified),
    createdAt: user.createdAt ?? null,
  };
}

function serializeProfile(profile, authUser) {
  if (!profile) return null;

  const imageVersion = profile.imageUpdatedAt ? new Date(profile.imageUpdatedAt).getTime() : 0;
  const imageCacheKey = profile.imageVersion || imageVersion;
  const image =
    profile.image === '/api/profile/image' && PROFILE_IMAGE_TYPES.has(profile.imageContentType)
      ? `${profile.image}?v=${imageCacheKey}`
      : (profile.image ?? authUser?.image ?? null);

  return {
    id: profile._id ? String(profile._id) : String(profile.userId),
    userId: String(profile.userId),
    name: cleanText(profile.name) || nameFromSession(authUser),
    email: cleanText(profile.email) || cleanText(authUser?.email),
    phone: profile.phone ?? '',
    location: profile.location ?? '',
    bio: profile.bio ?? '',
    image,
    createdAt: profile.createdAt ?? null,
    updatedAt: profile.updatedAt ?? null,
  };
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validate only the fields a client is allowed to edit. `name`, `phone`,
 * `location`, `bio` and `image` are profile data. Email and ids always come
 * from the verified session, never from the request body.
 */
function validateProfileBody(body, { allowEmpty = false } = {}) {
  const errors = [];
  const values = {};

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {
      errors: ['Request body must be a JSON object'],
      values,
    };
  }

  if (body.name !== undefined) {
    if (typeof body.name !== 'string') {
      errors.push('Name must be a string.');
    } else {
      const name = body.name.trim().replace(/\s+/g, ' ');
      if (!name) errors.push('Name cannot be empty.');
      else if (name.length > PROFILE_LIMITS.name) {
        errors.push(`Name must be ${PROFILE_LIMITS.name} characters or fewer.`);
      } else {
        values.name = name;
      }
    }
  }

  if (body.phone !== undefined) {
    if (typeof body.phone !== 'string') {
      errors.push('Phone must be a string.');
    } else {
      const phone = body.phone.trim();
      if (phone && !/^[+\d\s()-]{7,20}$/.test(phone)) {
        errors.push('Enter a valid phone number.');
      } else if (phone.length > PROFILE_LIMITS.phone) {
        errors.push(`Phone must be ${PROFILE_LIMITS.phone} characters or fewer.`);
      } else {
        values.phone = phone;
      }
    }
  }

  if (body.location !== undefined) {
    if (typeof body.location !== 'string') {
      errors.push('Location must be a string.');
    } else {
      const location = body.location.trim();
      if (location.length > PROFILE_LIMITS.location) {
        errors.push(`Location must be ${PROFILE_LIMITS.location} characters or fewer.`);
      } else {
        values.location = location;
      }
    }
  }

  if (body.bio !== undefined) {
    if (typeof body.bio !== 'string') {
      errors.push('Bio must be a string.');
    } else {
      const bio = body.bio.trim();
      if (bio.length > PROFILE_LIMITS.bio) {
        errors.push(`Bio must be ${PROFILE_LIMITS.bio} characters or fewer.`);
      } else {
        values.bio = bio;
      }
    }
  }

  if (body.image !== undefined) {
    if (body.image === null || body.image === '') {
      values.image = '';
    } else if (typeof body.image !== 'string') {
      errors.push('Image must be a string or null.');
    } else {
      const image = body.image.trim();
      if (image.length > PROFILE_LIMITS.image) {
        errors.push(`Image URL must be ${PROFILE_LIMITS.image} characters or fewer.`);
      } else if (image && !isValidHttpUrl(image)) {
        errors.push('Image must be a valid http(s) URL.');
      } else {
        values.image = image;
      }
    }
  }

  if (!errors.length && !allowEmpty && !Object.keys(values).length) {
    errors.push('Provide at least one profile field to update.');
  }

  return { errors, values };
}

/**
 * Turn validated values into a Mongo update. Empty phone/location/bio/image
 * values are removed from the document, which is how "clear this field"
 * works without deleting the profile or the auth account.
 */
function buildProfileUpdate(values, { userId, authUser, now }) {
  const set = {
    email: cleanText(authUser?.email),
    updatedAt: now,
  };
  const unset = {};

  for (const [field, value] of Object.entries(values)) {
    if (value === '' && DELETABLE_FIELDS.has(field)) {
      unset[field] = '';
    } else {
      set[field] = value;
    }
  }

  if ('image' in values) {
    clearProfileImageFields(unset);
  }

  const setOnInsert = {
    userId,
    createdAt: now,
  };

  if (!('name' in set) && !('name' in unset)) {
    setOnInsert.name = nameFromSession(authUser);
  }

  if (!('image' in set) && !('image' in unset) && authUser?.image) {
    setOnInsert.image = authUser.image;
  }

  const update = {
    $set: set,
    $setOnInsert: setOnInsert,
  };

  if (Object.keys(unset).length) {
    update.$unset = unset;
  }

  return update;
}

function clearProfileImageFields(unset) {
  Object.assign(unset, {
    imageData: '',
    imageContentType: '',
    imageUpdatedAt: '',
    imageVersion: '',
  });
}

async function getProfileStats(userId, authUser) {
  const [bookingCount, listingCount] = await Promise.all([
    bookings.countDocuments(renterBookingFilter(userId)),
    studios.countDocuments({ ownerId: userId }),
  ]);

  const accountCreatedAt = authUser?.createdAt ? new Date(authUser.createdAt) : null;
  const memberSince =
    accountCreatedAt && !Number.isNaN(accountCreatedAt.getTime())
      ? accountCreatedAt.getFullYear()
      : new Date().getFullYear();

  return {
    bookings: bookingCount,
    listings: listingCount,
    memberSince,
  };
}

function getDhakaDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

function getRecentDhakaMonths(date, count = 6) {
  const { year, month } = getDhakaDateParts(date);
  const currentMonth = Number(month) - 1;

  return Array.from({ length: count }, (_, index) => {
    const monthDate = new Date(Date.UTC(Number(year), currentMonth - (count - index - 1), 1));
    const monthYear = monthDate.getUTCFullYear();
    const monthNumber = String(monthDate.getUTCMonth() + 1).padStart(2, '0');

    return {
      key: `${monthYear}-${monthNumber}`,
      label: new Intl.DateTimeFormat('en', {
        month: 'short',
        timeZone: 'UTC',
      }).format(monthDate),
    };
  });
}

async function getDashboardStats(userId, now = new Date()) {
  const renterFilter = renterBookingFilter(userId);
  const todayParts = getDhakaDateParts(now);
  const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;
  const recentMonths = getRecentDhakaMonths(now);

  const [
    renterBookings,
    upcomingBookings,
    renterSpending,
    ownedStudios,
    hostBookings,
    pendingRequests,
    hostEarnings,
    wishlist,
    monthlyEarnings,
  ] = await Promise.all([
    bookings.countDocuments(renterFilter),
    bookings.countDocuments({
      ...renterFilter,
      bookingDate: { $gte: today },
      status: { $in: ['Pending', 'Confirmed'] },
    }),
    bookings
      .aggregate([
        {
          $match: {
            ...renterFilter,
            status: 'Completed',
          },
        },
        {
          $group: {
            _id: null,
            total: {
              $sum: { $ifNull: ['$total', { $ifNull: ['$subtotal', 0] }] },
            },
          },
        },
      ])
      .toArray(),
    studios.countDocuments({ ownerId: userId }),
    bookings.countDocuments({ ownerId: userId }),
    bookings.countDocuments({ ownerId: userId, status: 'Pending' }),
    bookings
      .aggregate([
        {
          $match: {
            ownerId: userId,
            status: 'Completed',
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $ifNull: ['$subtotal', 0] } },
          },
        },
      ])
      .toArray(),
    wishlists.findOne({ userId }, { projection: { studioIds: 1 } }),
    bookings
      .aggregate([
        {
          $match: {
            ownerId: userId,
            status: 'Completed',
            bookingDate: { $in: recentMonths.map(({ key }) => key) },
          },
        },
        {
          $group: {
            _id: { $substrBytes: ['$bookingDate', 0, 7] },
            amount: { $sum: { $ifNull: ['$subtotal', 0] } },
          },
        },
      ])
      .toArray(),
  ]);

  const savedStudioIds = Array.isArray(wishlist?.studioIds)
    ? [...new Set(wishlist.studioIds.filter(isValidObjectId))]
    : [];
  const savedStudios = savedStudioIds.length
    ? await studios.countDocuments({
        _id: { $in: savedStudioIds.map((id) => new ObjectId(id)) },
        status: { $in: ['active', 'published'] },
      })
    : 0;
  const monthlyTotals = new Map(monthlyEarnings.map(({ _id, amount }) => [_id, amount]));

  return {
    renter: {
      totalBookings: renterBookings,
      savedStudios,
      upcomingBookings,
      totalSpent: renterSpending[0]?.total || 0,
    },
    host: {
      totalStudios: ownedStudios,
      totalBookings: hostBookings,
      pendingRequests,
      earnings: hostEarnings[0]?.total || 0,
      monthlyEarnings: recentMonths.map(({ key, label }) => ({
        month: label,
        amount: monthlyTotals.get(key) || 0,
      })),
    },
  };
}

function serializeRecord(document) {
  const { _id, ...record } = document;
  return { ...record, id: String(_id) };
}

function serializeReview(document) {
  const { _id, userId, bookingId, ...review } = document;
  return { ...review, id: String(_id) };
}

function serializeNotification(document) {
  const { _id, userId, ...notification } = document;
  return { ...notification, id: String(_id) };
}

async function insertNotification(userId, notification, session) {
  if (typeof userId !== 'string' || !userId) return;

  await notifications.insertOne(
    {
      _id: new ObjectId(),
      userId,
      ...notification,
      isRead: false,
      createdAt: new Date(),
    },
    { session },
  );
}

function formatBookingNotificationDate(booking) {
  const date = new Date(`${booking.bookingDate}T00:00:00+06:00`);
  if (Number.isNaN(date.getTime())) return cleanText(booking.bookingDate);

  return new Intl.DateTimeFormat('en-BD', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Dhaka',
  }).format(date);
}

function bookingError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function renterBookingFilter(userId) {
  return { $or: [{ renterId: userId }, { userId }] };
}

function bookingParticipantFilter(userId) {
  return {
    $or: [{ renterId: userId }, { ownerId: userId }, { userId }],
  };
}

function isValidBookingDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function bookingTimeMinutes(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    return null;
  }

  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

const STUDIO_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function legacyOpeningHours(availableDays, opens, closes) {
  const days = new Set(Array.isArray(availableDays) ? availableDays : STUDIO_WEEKDAYS.slice(0, 6));
  if ([...days].some((day) => !STUDIO_WEEKDAYS.includes(day))) {
    throw studioValidationError('Studio available days are invalid');
  }
  const openMinutes = bookingTimeMinutes(opens);
  const closeMinutes = bookingTimeMinutes(closes);
  if (days.size > 0 && (openMinutes === null || closeMinutes <= openMinutes)) {
    throw studioValidationError('Studio legacy opening hours are invalid');
  }
  const openTime = openMinutes === null ? '08:00' : opens;
  const closeTime = closeMinutes === null ? '22:00' : closes;

  return Object.fromEntries(
    STUDIO_WEEKDAYS.map((day) => [
      day,
      { opens: openTime, closes: closeTime, closed: !days.has(day) },
    ]),
  );
}

function normalizeOpeningHours(value, availableDays, opens, closes) {
  if (value === undefined || value === null) {
    return legacyOpeningHours(availableDays, opens, closes);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw studioValidationError('Studio opening hours are invalid');
  }

  const schedule = {};
  for (const day of STUDIO_WEEKDAYS) {
    const hours = value[day];
    const openingMinutes = bookingTimeMinutes(hours?.opens);
    const closingMinutes = bookingTimeMinutes(hours?.closes);
    if (
      !hours ||
      typeof hours !== 'object' ||
      Array.isArray(hours) ||
      typeof hours.closed !== 'boolean' ||
      openingMinutes === null ||
      closingMinutes === null ||
      (!hours.closed && closingMinutes <= openingMinutes)
    ) {
      throw studioValidationError(`Studio opening hours are invalid for ${day}`);
    }

    schedule[day] = {
      opens: hours.opens,
      closes: hours.closes,
      closed: hours.closed,
    };
  }
  return schedule;
}

function bookingHasEnded(booking) {
  const endAt = Date.parse(`${booking.bookingDate}T${booking.endTime}:00+06:00`);
  return Number.isFinite(endAt) && endAt <= Date.now();
}

function validateBookingDetails(studio, input) {
  const bookingDate = input?.bookingDate;
  const startTime = input?.startTime;
  const endTime = input?.endTime;
  const startMinutes = bookingTimeMinutes(startTime);
  const endMinutes = bookingTimeMinutes(endTime);
  const guests = input?.guests;

  if (!isValidBookingDate(bookingDate) || startMinutes === null || endMinutes === null) {
    throw bookingError(400, 'Choose a valid booking date and time');
  }
  if (endMinutes <= startMinutes) {
    throw bookingError(400, 'The booking end time must be after the start time');
  }

  const startAt = Date.parse(`${bookingDate}T${startTime}:00+06:00`);
  if (!Number.isFinite(startAt) || startAt <= Date.now()) {
    throw bookingError(400, 'Choose a future booking time');
  }

  const durationHours = (endMinutes - startMinutes) / 60;
  const minimumHours = Number(studio.details?.minimumHours) || 1;
  const capacity = Number(studio.details?.maxGuests) || 0;
  if (durationHours < minimumHours) {
    throw bookingError(400, `This studio requires a minimum booking of ${minimumHours} hours`);
  }
  if (!Number.isInteger(guests) || guests < 1 || guests > capacity) {
    throw bookingError(400, `Guest count must be between 1 and ${capacity}`);
  }

  const day = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
  }).format(new Date(`${bookingDate}T12:00:00.000Z`));
  const dailyHours = normalizeOpeningHours(
    studio.details?.openingHours,
    studio.details?.availableDays,
    studio.details?.opens,
    studio.details?.closes,
  )[day];
  if (!dailyHours || dailyHours.closed) {
    throw bookingError(409, 'This studio is not available on that day');
  }
  if (studio.details?.unavailableDate === bookingDate) {
    throw bookingError(409, 'This studio is unavailable on that date');
  }

  const opens = bookingTimeMinutes(dailyHours.opens);
  const closes = bookingTimeMinutes(dailyHours.closes);
  if (opens !== null && closes !== null && (startMinutes < opens || endMinutes > closes)) {
    throw bookingError(409, 'Choose a time within the studio opening hours');
  }

  const hourlyRate = Number(studio.price ?? studio.details?.hourlyRate);
  if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) {
    throw bookingError(409, 'This studio is not available for booking');
  }

  const subtotal = hourlyRate * durationHours;
  const serviceFee = Math.round(subtotal * BOOKING_SERVICE_FEE_RATE);
  const firstPhoto = studio.details?.photos?.[0];
  const studioImage =
    typeof firstPhoto === 'string' && firstPhoto.startsWith('stored:')
      ? `/api/studios/${studio._id}/photos/0`
      : firstPhoto || null;

  return {
    studioId: String(studio._id),
    ownerId: studio.ownerId,
    renterId: null,
    userId: null,
    studioName: cleanText(studio.name || studio.details?.name),
    studioLocation: [
      cleanText(studio.city || studio.details?.city),
      cleanText(studio.details?.country),
    ]
      .filter(Boolean)
      .join(', '),
    studioImage,
    hostName: cleanText(studio.ownerName) || 'Studio host',
    bookingDate,
    startTime,
    endTime,
    durationHours,
    guests,
    hourlyRate,
    subtotal,
    serviceFee,
    total: subtotal + serviceFee,
  };
}

function getRasterImageContentType(image) {
  if (!Buffer.isBuffer(image)) return null;
  if (image.length >= 3 && image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    image.length >= 8 &&
    image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'image/png';
  }
  if (image.length >= 6 && ['GIF87a', 'GIF89a'].includes(image.toString('ascii', 0, 6))) {
    return 'image/gif';
  }
  if (
    image.length >= 12 &&
    image.toString('ascii', 0, 4) === 'RIFF' &&
    image.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

const SAFE_SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'path', 'rect', 'circle', 'ellipse', 'line',
  'polyline', 'polygon', 'lineargradient', 'radialgradient', 'stop',
  'clippath', 'mask', 'pattern', 'symbol', 'use', 'title', 'desc',
  'text', 'tspan',
]);
const SAFE_SVG_ATTRIBUTES = new Set([
  'xmlns', 'xmlns:xlink', 'id', 'width', 'height', 'viewbox',
  'preserveaspectratio', 'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'points', 'fill', 'fill-rule',
  'clip-rule', 'stroke', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'opacity', 'fill-opacity', 'stroke-opacity', 'transform', 'offset',
  'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform',
  'spreadmethod', 'clippathunits', 'maskunits', 'maskcontentunits',
  'patternunits', 'patterncontentunits', 'patterntransform',
  'font-family', 'font-size', 'font-weight', 'text-anchor',
  'dominant-baseline', 'href', 'xlink:href',
]);

function sanitizeSvgImage(image) {
  if (!Buffer.isBuffer(image) || image.length === 0) return null;
  const source = image.toString('utf8').replace(/^\uFEFF/, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) return null;

  try {
    const document = new DOMParser({
      onError() {
        throw new Error('Invalid SVG document');
      },
    }).parseFromString(source, 'image/svg+xml');
    const root = document.documentElement;
    if (
      !root ||
      root.localName.toLowerCase() !== 'svg' ||
      (root.namespaceURI &&
        root.namespaceURI !== 'http://www.w3.org/2000/svg')
    ) {
      return null;
    }

    function clean(element) {
      for (const child of Array.from(element.childNodes)) {
        if (child.nodeType === 1) {
          if (!SAFE_SVG_ELEMENTS.has(child.localName.toLowerCase())) {
            element.removeChild(child);
            continue;
          }
          clean(child);
        } else if (child.nodeType === 7 || child.nodeType === 8 || child.nodeType === 10) {
          element.removeChild(child);
        }
      }

      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim();
        const localReference = /^#[\w:.-]+$/.test(value);
        const localUrl = /^url\(\s*(['"]?)#[\w:.-]+\1\s*\)$/i.test(value);
        const invalidUrl = /url\s*\(/i.test(value) && !localUrl;
        if (
          !SAFE_SVG_ATTRIBUTES.has(name) ||
          (name === 'xmlns' && value !== 'http://www.w3.org/2000/svg') ||
          (name === 'xmlns:xlink' && value !== 'http://www.w3.org/1999/xlink') ||
          ((name === 'href' || name === 'xlink:href') && !localReference) ||
          invalidUrl ||
          /javascript:|data:/i.test(value)
        ) {
          element.removeAttribute(attribute.name);
        }
      }
    }

    if (!root.hasAttribute('xmlns')) {
      root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    }
    clean(root);
    const sanitized = Buffer.from(
      new XMLSerializer().serializeToString(root),
      'utf8',
    );
    return sanitized.length > 0 && sanitized.length <= PROFILE_IMAGE_MAX_BYTES
      ? sanitized
      : null;
  } catch {
    return null;
  }
}

function normalizeImageBuffer(image) {
  const rasterType = getRasterImageContentType(image);
  if (rasterType) return { buffer: image, contentType: rasterType };

  const sanitizedSvg = sanitizeSvgImage(image);
  return sanitizedSvg
    ? { buffer: sanitizedSvg, contentType: 'image/svg+xml' }
    : null;
}

function studioValidationError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function normalizeStudioPhoto(photo, existing, studioId, photoData) {
  if (typeof photo !== 'string') {
    throw studioValidationError('A studio photo is invalid or too large');
  }

  if (photo.startsWith('data:')) {
    const dataUrl = /^data:[^;,]+;base64,([A-Za-z0-9+/]+={0,2})$/.exec(photo);
    if (!dataUrl || photo.length > MAX_STUDIO_PHOTO_DATA_URL_LENGTH) {
      throw studioValidationError(
        'Use a valid JPEG, PNG, WebP, GIF or SVG image up to 1 MB',
      );
    }

    const originalImage = Buffer.from(dataUrl[1], 'base64');
    const normalizedImage = normalizeImageBuffer(originalImage);
    if (
      originalImage.length === 0 ||
      originalImage.length > STUDIO_PHOTO_MAX_BYTES ||
      originalImage.toString('base64') !== dataUrl[1] ||
      !normalizedImage
    ) {
      throw studioValidationError(
        'Use a valid JPEG, PNG, WebP, GIF or SVG image up to 1 MB',
      );
    }

    const reference = `stored:${new ObjectId()}`;
    photoData[reference] = {
      contentType: normalizedImage.contentType,
      data: normalizedImage.buffer.toString('base64'),
    };
    return reference;
  }

  if (photo.length > 2048) {
    throw studioValidationError('A studio photo URL is invalid');
  }

  const storedPhoto = photo.match(/\/api\/studios\/([a-f\d]{24})\/photos\/(\d+)(?:\?.*)?$/i);
  if (storedPhoto && storedPhoto[1].toLowerCase() === studioId.toLowerCase()) {
    const previous = existing?.details?.photos?.[Number(storedPhoto[2])];
    if (typeof previous === 'string' && existing.photoData?.[previous]) {
      photoData[previous] = existing.photoData[previous];
      return previous;
    }
    throw studioValidationError('A saved studio photo could not be found');
  }

  if (photo.startsWith('/_next/static/')) return photo;

  try {
    const url = new URL(photo);
    if (url.protocol === 'https:' || url.protocol === 'http:') return photo;
  } catch {
    // Invalid URL values are rejected below.
  }

  throw studioValidationError('A studio photo URL is invalid');
}

function normalizeStudioDetails(input, existing, studioId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw studioValidationError('Studio details are required');
  }

  const stringLimits = {
    name: 120,
    category: 64,
    shortDescription: 240,
    fullDescription: 5000,
    country: 100,
    city: 100,
    area: 120,
    streetAddress: 250,
    hourlyRate: 16,
    minimumHours: 16,
    cleaningFee: 16,
    maxGuests: 16,
    studioSize: 16,
    opens: 16,
    closes: 16,
    unavailableDate: 32,
    cancellationPolicy: 40,
    studioRules: 5000,
    additionalInstructions: 2000,
  };
  const details = {};

  for (const [field, maxLength] of Object.entries(stringLimits)) {
    const value = input[field];
    if (typeof value !== 'string' || value.length > maxLength) {
      throw studioValidationError(`Studio ${field} is invalid`);
    }
    details[field] = value;
  }

  if (!STUDIO_CATEGORIES.has(details.category)) {
    throw studioValidationError('Choose a supported studio category');
  }

  for (const field of ['amenities', 'availableDays']) {
    const values = input[field];
    const maxLength = field === 'amenities' ? 32 : 7;
    if (
      !Array.isArray(values) ||
      values.length > maxLength ||
      values.some((value) => typeof value !== 'string' || value.length > 100)
    ) {
      throw studioValidationError(`Studio ${field} are invalid`);
    }
    details[field] = [...new Set(values)];
  }
  details.openingHours = normalizeOpeningHours(
    input.openingHours,
    details.availableDays,
    details.opens,
    details.closes,
  );
  details.availableDays = STUDIO_WEEKDAYS.filter((day) => !details.openingHours[day].closed);
  const firstOpenDay = STUDIO_WEEKDAYS.find((day) => !details.openingHours[day].closed);
  if (firstOpenDay) {
    details.opens = details.openingHours[firstOpenDay].opens;
    details.closes = details.openingHours[firstOpenDay].closes;
  }

  if (!Array.isArray(input.photos) || input.photos.length > STUDIO_PHOTO_MAX_COUNT) {
    throw studioValidationError(`Add no more than ${STUDIO_PHOTO_MAX_COUNT} studio photos`);
  }
  const photoData = {};
  details.photos = input.photos.map((photo) =>
    normalizeStudioPhoto(photo, existing, studioId, photoData),
  );
  return { details, photoData };
}

function validatePublishableStudio(details) {
  const name = typeof details?.name === 'string' ? details.name.trim() : '';
  const description =
    typeof details?.shortDescription === 'string' ? details.shortDescription.trim() : '';
  const city = typeof details?.city === 'string' ? details.city.trim() : '';
  const price = Number(details?.hourlyRate);
  const minimumHours = Number(details?.minimumHours);
  const capacity = Number(details?.maxGuests);
  const photos = Array.isArray(details?.photos) ? details.photos : [];
  if (
    !name ||
    !description ||
    !city ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(minimumHours) ||
    minimumHours <= 0 ||
    !Number.isFinite(capacity) ||
    capacity < 1 ||
    photos.length === 0
  ) {
    throw studioValidationError(
      'Published studios need a name, description, city, valid hourly rate, minimum hours, guest capacity and at least one photo',
    );
  }
  if (!STUDIO_WEEKDAYS.some((day) => !details.openingHours?.[day]?.closed)) {
    throw studioValidationError('Published studios need to be open at least one day each week');
  }
}

function serializeStudio(document, { includePrivate = false } = {}) {
  const id = String(document._id);
  const details = { ...(document.details || {}) };
  details.openingHours = normalizeOpeningHours(
    details.openingHours,
    details.availableDays,
    details.opens,
    details.closes,
  );
  const photos = (details.photos || []).map((photo, index) =>
    typeof photo === 'string' && photo.startsWith('stored:')
      ? `/api/studios/${id}/photos/${index}`
      : photo,
  );
  details.photos = photos;
  if (!includePrivate) {
    details.streetAddress = '';
    details.availableDays = [];
    details.opens = '';
    details.closes = '';
    details.unavailableDate = '';
    details.additionalInstructions = '';
  }

  const category = document.category || details.category;
  const city = document.city || details.city || '';
  const country = details.country || '';

  return {
    id,
    ownerId: includePrivate ? document.ownerId : undefined,
    name: document.name || details.name || '',
    category,
    categoryLabel: STUDIO_CATEGORY_LABELS[category] || category,
    discipline: STUDIO_CATEGORY_DISCIPLINES[category] || category,
    city,
    location: [city, country].filter(Boolean).join(', '),
    price: Number(document.price ?? details.hourlyRate) || 0,
    status: document.status,
    featured: document.featured === true,
    rating: Number(document.rating) || 0,
    reviews: Number(document.reviewCount) || 0,
    image: photos[0] || null,
    photos,
    details,
    ownerName: document.ownerName || 'Studio host',
    ownerCreatedAt: document.ownerCreatedAt || null,
    createdAt: document.createdAt || null,
    updatedAt: document.updatedAt || null,
  };
}

/* ------------------------------------------------------------------ */
/* 6. Marketplace read APIs                                            */
/* ------------------------------------------------------------------ */

app.use('/api', async (req, res, next) => {
  try {
    await ensureMongoReady();
    next();
  } catch {
    return sendError(res, 503, 'Database foundation is not ready');
  }
});

app.post(
  '/api/contact',
  withApiErrorHandling(
    async (req, res) => {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const email = normalizeEmail(body.email);
      const topic = typeof body.topic === 'string' ? body.topic.trim() : '';
      const message = typeof body.message === 'string' ? body.message.trim() : '';

      if (
        !name ||
        name.length > CONTACT_NAME_MAX_LENGTH ||
        !isValidEmail(email) ||
        !topic ||
        topic.length > CONTACT_TOPIC_MAX_LENGTH ||
        !message ||
        message.length > CONTACT_MESSAGE_MAX_LENGTH
      ) {
        return sendError(res, 400, 'Please provide valid contact form details');
      }

      const now = new Date();
      await contactMessages.insertOne({
        name,
        email,
        topic,
        message,
        status: 'new',
        createdAt: now,
        updatedAt: now,
      });

      return sendSuccess(res, {
        status: 201,
        message: 'Contact message received',
        data: { received: true },
      });
    },
    'Could not save your message',
    {
      logMessage: 'Failed to store contact message:',
    },
  ),
);

app.post(
  '/api/newsletter',
  withApiErrorHandling(
    async (req, res) => {
      const email = normalizeEmail(req.body?.email);
      if (!isValidEmail(email)) {
        return sendError(res, 400, 'Please provide a valid email address');
      }

      const now = new Date();
      const result = await newsletterSubscribers.updateOne(
        { email },
        {
          $setOnInsert: { email, createdAt: now },
          $set: { updatedAt: now },
        },
        { upsert: true },
      );
      const alreadySubscribed = result.upsertedCount === 0;

      return sendSuccess(res, {
        status: alreadySubscribed ? 200 : 201,
        message: alreadySubscribed
          ? 'Email is already subscribed'
          : 'Newsletter subscription saved',
        data: { subscribed: true, alreadySubscribed },
      });
    },
    'Could not save your subscription',
    {
      logMessage: 'Failed to save newsletter subscription:',
      onError(error, _req, res) {
        if (error?.code === 11000) {
          return sendSuccess(res, {
            message: 'Email is already subscribed',
            data: { subscribed: true, alreadySubscribed: true },
          });
        }

        console.error('Failed to save newsletter subscription:', error);
        return sendError(res, 500, 'Could not save your subscription');
      },
    },
  ),
);

/**
 * GET /api/stats
 * Return the signed-in user's renter and host dashboard metrics.
 */
app.get(
  '/api/stats',
  requireSession,
  withApiErrorHandling(async (req, res) => {
    const data = await getDashboardStats(req.userId);
    return sendSuccess(res, { message: 'Dashboard stats loaded', data });
  }, 'Failed to load dashboard stats'),
);

app.get(
  '/api/host/onboarding',
  requireSession,
  withApiErrorHandling(async (req, res) => {
    const data = await getHostOnboardingState(req.userId);
    return sendSuccess(res, { message: 'Host onboarding status loaded', data });
  }, 'Failed to load host onboarding status'),
);

app.post(
  '/api/host/onboarding/complete',
  requireSession,
  withApiErrorHandling(async (req, res) => {
    const state = await getHostOnboardingState(req.userId);

    if (state.hasHostedStudio || state.onboardingCompleted) {
      return sendSuccess(res, {
        message: 'Host onboarding is already complete',
        data: state,
      });
    }

    if (!state.profileComplete) {
      return sendError(
        res,
        400,
        `Enter a full name of ${PROFILE_LIMITS.name} characters or fewer in your profile before starting to host`,
      );
    }

    const now = new Date();
    const update = {
      $set: { hostOnboardingCompleted: true, updatedAt: now },
      $setOnInsert: {
        userId: req.userId,
        name: cleanText(req.authUser.name),
        email: cleanText(req.authUser.email),
        createdAt: now,
      },
    };

    try {
      await userProfiles.updateOne({ userId: req.userId }, update, { upsert: true });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      await userProfiles.updateOne(
        { userId: req.userId },
        { $set: { hostOnboardingCompleted: true, updatedAt: now } },
      );
    }

    const data = await getHostOnboardingState(req.userId);
    return sendSuccess(res, { message: 'Host onboarding completed', data });
  }, 'Failed to complete host onboarding'),
);

/**
 * GET /api/wishlists
 * Return the signed-in user's saved, currently published studios.
 */
app.get(
  '/api/wishlists',
  requireSession,
  withApiErrorHandling(async (req, res) => {
    const wishlist = await wishlists.findOne(
      { userId: req.userId },
      { projection: { studioIds: 1 } },
    );
    const studioIds = Array.isArray(wishlist?.studioIds)
      ? wishlist.studioIds.filter(isValidObjectId)
      : [];
    const objectIds = studioIds.map((id) => new ObjectId(id));

    const savedStudios = objectIds.length
      ? await studios
          .find(
            {
              _id: { $in: objectIds },
              status: { $in: ['active', 'published'] },
            },
            { projection: { photoData: 0 } },
          )
          .toArray()
      : [];
    const studiosById = new Map(savedStudios.map((studio) => [String(studio._id), studio]));

    return sendSuccess(res, {
      message: 'Saved studios loaded',
      data: studioIds
        .map((id) => studiosById.get(id))
        .filter(Boolean)
        .map((studio) => serializeStudio(studio)),
    });
  }, 'Failed to load saved studios'),
);

/**
 * POST /api/wishlists
 * Save a published studio for the verified session user.
 */
app.post(
  '/api/wishlists',
  requireSession,
  withApiErrorHandling(async (req, res) => {
    const studioId = typeof req.body?.studioId === 'string' ? req.body.studioId.trim() : '';
    if (!isValidObjectId(studioId)) {
      return sendError(res, 400, 'Studio id is invalid');
    }

    const studio = await studios.findOne({
      _id: new ObjectId(studioId),
      status: { $in: ['active', 'published'] },
    });
    if (!studio) return sendError(res, 404, 'Studio not found');

    const now = new Date();
    try {
      await wishlists.updateOne(
        { userId: req.userId },
        {
          $setOnInsert: { userId: req.userId, createdAt: now },
          $addToSet: { studioIds: studioId },
          $set: { updatedAt: now },
        },
        { upsert: true },
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
      await wishlists.updateOne(
        { userId: req.userId },
        {
          $addToSet: { studioIds: studioId },
          $set: { updatedAt: now },
        },
      );
    }

    return sendSuccess(res, {
      status: 201,
      message: 'Studio saved',
      data: serializeStudio(studio),
    });
  }, 'Failed to save studio'),
);

/**
 * DELETE /api/wishlists/:studioId
 * Remove a studio from the verified user's saved list.
 */
app.delete(
  '/api/wishlists/:studioId',
  requireSession,
  withApiErrorHandling(async (req, res) => {
    const { studioId } = req.params;
    if (!isValidObjectId(studioId)) {
      return sendError(res, 400, 'Studio id is invalid');
    }

    await wishlists.updateOne(
      { userId: req.userId },
      {
        $pull: { studioIds: studioId },
        $set: { updatedAt: new Date() },
      },
    );
    return sendSuccess(res, {
      message: 'Studio removed from saved studios',
      data: { studioId },
    });
  }, 'Failed to remove saved studio'),
);

/**
 * GET /api/studios
 * Return studios available to renters; drafts are not public.
 */
app.get(
  '/api/studios',
  withApiErrorHandling(async (_req, res) => {
    const data = await studios
      .find({ status: { $in: ['active', 'published'] } }, { projection: { photoData: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
    return sendSuccess(res, {
      message: 'Studios loaded',
      data: data.map((studio) => serializeStudio(studio)),
    });
  }, 'Failed to load studios'),
);

app.get(
  '/api/studios/mine',
  requireSession,
  withApiErrorHandling(
    async (req, res) => {
      const data = await studios
        .find({ ownerId: req.userId }, { projection: { photoData: 0 } })
        .sort({ updatedAt: -1 })
        .toArray();
      return sendSuccess(res, {
        message: 'Your studios loaded',
        data: data.map((studio) => serializeStudio(studio, { includePrivate: true })),
      });
    },
    'Failed to load your studios',
    {
      logMessage: 'Failed to load host studios:',
    },
  ),
);

app.get(
  '/api/studios/mine/:id',
  requireSession,
  withApiErrorHandling(
    async (req, res) => {
      if (!isValidObjectId(req.params.id)) {
        return sendError(res, 404, 'Studio not found');
      }

      const studio = await studios.findOne(
        { _id: new ObjectId(req.params.id), ownerId: req.userId },
        { projection: { photoData: 0 } },
      );
      if (!studio) return sendError(res, 404, 'Studio not found');

      return sendSuccess(res, {
        message: 'Studio loaded',
        data: serializeStudio(studio, { includePrivate: true }),
      });
    },
    'Failed to load studio',
    { logMessage: 'Failed to load host studio:' },
  ),
);

app.post(
  '/api/studios',
  requireSession,
  handleStudioJsonBody,
  withStudioErrorHandling(async (req, res) => {
    const status = req.body?.status || 'draft';
    if (!['draft', 'published'].includes(status)) {
      return sendError(res, 400, 'Studio status is invalid');
    }

    const id = new ObjectId();
    const { details, photoData } = normalizeStudioDetails(req.body?.details, null, String(id));
    if (status === 'published') validatePublishableStudio(details);

    const now = new Date();
    const studio = {
      _id: id,
      ownerId: req.userId,
      ownerName: cleanText(req.authUser.name) || 'Studio host',
      ownerCreatedAt: req.authUser.createdAt ? new Date(req.authUser.createdAt) : null,
      name: cleanText(details.name),
      category: details.category,
      city: cleanText(details.city),
      price: Number(details.hourlyRate) || 0,
      status,
      featured: false,
      rating: 0,
      reviewCount: 0,
      details,
      photoData,
      createdAt: now,
      updatedAt: now,
    };

    await studios.insertOne(studio);
    return sendSuccess(res, {
      status: 201,
      message: 'Studio created',
      data: serializeStudio(studio, { includePrivate: true }),
    });
  }, 'Failed to create studio'),
);

app.patch(
  '/api/studios/:id',
  requireSession,
  handleStudioJsonBody,
  withStudioErrorHandling(async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      return sendError(res, 404, 'Studio not found');
    }

    const id = new ObjectId(req.params.id);
    const current = await studios.findOne({ _id: id, ownerId: req.userId });
    if (!current) return sendError(res, 404, 'Studio not found');

    const { details, photoData } = normalizeStudioDetails(req.body?.details, current, String(id));
    const status = req.body?.status ?? current.status;
    if (!['draft', 'published'].includes(status)) {
      return sendError(res, 400, 'Studio status is invalid');
    }
    if (status === 'published') validatePublishableStudio(details);

    const updated = {
      ...current,
      name: cleanText(details.name),
      category: details.category,
      city: cleanText(details.city),
      price: Number(details.hourlyRate) || 0,
      status,
      details,
      photoData,
      updatedAt: new Date(),
    };
    await studios.replaceOne({ _id: id, ownerId: req.userId }, updated);

    return sendSuccess(res, {
      message: 'Studio updated',
      data: serializeStudio(updated, { includePrivate: true }),
    });
  }, 'Failed to update studio'),
);

app.patch(
  '/api/studios/:id/status',
  requireSession,
  handleStudioJsonBody,
  withStudioErrorHandling(async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      return sendError(res, 404, 'Studio not found');
    }
    if (!['draft', 'published'].includes(req.body?.status)) {
      return sendError(res, 400, 'Studio status is invalid');
    }

    const id = new ObjectId(req.params.id);
    const studio = await studios.findOne({ _id: id, ownerId: req.userId });
    if (!studio) return sendError(res, 404, 'Studio not found');
    if (req.body.status === 'published') {
      validatePublishableStudio(studio.details || {});
    }

    const updated = {
      ...studio,
      status: req.body.status,
      updatedAt: new Date(),
    };
    await studios.updateOne(
      { _id: id, ownerId: req.userId },
      { $set: { status: updated.status, updatedAt: updated.updatedAt } },
    );
    return sendSuccess(res, {
      message: 'Studio status updated',
      data: serializeStudio(updated, { includePrivate: true }),
    });
  }, 'Failed to change studio status'),
);

app.delete(
  '/api/studios/:id',
  requireSession,
  withApiErrorHandling(async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      return sendError(res, 404, 'Studio not found');
    }

    const result = await studios.deleteOne({
      _id: new ObjectId(req.params.id),
      ownerId: req.userId,
    });
    if (result.deletedCount === 0) {
      return sendError(res, 404, 'Studio not found');
    }
    return sendSuccess(res, { message: 'Studio deleted' });
  }, 'Failed to delete studio'),
);

app.get(
  '/api/studios/:id/photos/:index',
  withApiErrorHandling(async (req, res) => {
    if (!isValidObjectId(req.params.id) || !/^\d+$/.test(req.params.index)) {
      return sendError(res, 404, 'Studio photo not found');
    }

    const studio = await studios.findOne(
      { _id: new ObjectId(req.params.id) },
      {
        projection: {
          status: 1,
          ownerId: 1,
          'details.photos': 1,
          photoData: 1,
        },
      },
    );
    if (!studio) return sendError(res, 404, 'Studio photo not found');

    const isPublic = ['active', 'published'].includes(studio.status);
    if (!isPublic) {
      const session = await getBetterAuthSession(req);
      if (!session?.user?.id || session.user.id !== studio.ownerId) {
        return sendError(res, 404, 'Studio photo not found');
      }
    }

    const photo = studio.details?.photos?.[Number(req.params.index)];
    const storedPhoto =
      typeof photo === 'string' && photo.startsWith('stored:') ? studio.photoData?.[photo] : null;
    if (
      !storedPhoto ||
      !STUDIO_PHOTO_TYPES.has(storedPhoto.contentType) ||
      typeof storedPhoto.data !== 'string'
    ) {
      return sendError(res, 404, 'Studio photo not found');
    }

    const image = Buffer.from(storedPhoto.data, 'base64');
    const normalizedImage = normalizeImageBuffer(image);
    if (
      image.length === 0 ||
      image.length > STUDIO_PHOTO_MAX_BYTES ||
      !normalizedImage
    ) {
      return sendError(res, 404, 'Studio photo not found');
    }

    res.set({
      'Cache-Control': 'private, no-store',
      'Content-Length': String(normalizedImage.buffer.length),
      'Content-Type': normalizedImage.contentType,
      'X-Content-Type-Options': 'nosniff',
    });
    if (normalizedImage.contentType === 'image/svg+xml') {
      res.set('Content-Security-Policy', "default-src 'none'; sandbox");
    }
    return res.send(normalizedImage.buffer);
  }, 'Failed to load studio photo'),
);

app.get(
  '/api/studios/:id/contact',
  requireSession,
  withApiErrorHandling(async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      return sendError(res, 404, 'Studio not found');
    }

    const studio = await studios.findOne(
      {
        _id: new ObjectId(req.params.id),
        status: { $in: ['active', 'published'] },
      },
      { projection: { ownerId: 1 } },
    );
    if (!studio) return sendError(res, 404, 'Studio not found');

    const profile = await userProfiles.findOne(
      { userId: studio.ownerId },
      { projection: { phone: 1 } },
    );
    return sendSuccess(res, {
      message: 'Studio contact loaded',
      data: { phone: normalizeContactPhone(profile?.phone) },
    });
  }, 'Failed to load studio contact'),
);

app.get(
  '/api/studios/:id',
  withApiErrorHandling(async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      return sendError(res, 404, 'Studio not found');
    }

    const studio = await studios.findOne(
      {
        _id: new ObjectId(req.params.id),
        status: { $in: ['active', 'published'] },
      },
      { projection: { photoData: 0 } },
    );
    if (!studio) return sendError(res, 404, 'Studio not found');

    return sendSuccess(res, {
      message: 'Studio loaded',
      data: serializeStudio(studio),
    });
  }, 'Failed to load studio'),
);

/**
 * GET /api/bookings?role=renter|host
 * Return only bookings associated with the verified user.
 */
app.get(
  '/api/bookings',
  requireSession,
  withApiErrorHandling(async (req, res) => {
    const role = typeof req.query.role === 'string' ? req.query.role : '';
    if (role && !['renter', 'host'].includes(role)) {
      return sendError(res, 400, 'Booking role is invalid');
    }

    const filter =
      role === 'renter'
        ? renterBookingFilter(req.userId)
        : role === 'host'
          ? { ownerId: req.userId }
          : bookingParticipantFilter(req.userId);

    const data = await bookings.find(filter).sort({ createdAt: -1 }).toArray();
    return sendSuccess(res, {
      message: 'Bookings loaded',
      data: data.map(serializeRecord),
    });
  }, 'Failed to load bookings'),
);

/**
 * POST /api/bookings
 * Create a pending booking using the verified renter and stored studio data.
 */
app.post(
  '/api/bookings',
  requireSession,
  withBookingErrorHandling(async (req, res) => {
    const studioId = typeof req.body?.studioId === 'string' ? req.body.studioId.trim() : '';
    if (!isValidObjectId(studioId)) {
      return sendError(res, 400, 'Studio id is invalid');
    }

    const session = client.startSession();
    let createdBooking;
    try {
      await session.withTransaction(async () => {
        const studio = await studios.findOne(
          {
            _id: new ObjectId(studioId),
            status: { $in: ['active', 'published'] },
          },
          { projection: { photoData: 0 }, session },
        );
        if (!studio) throw bookingError(404, 'Studio not found');
        if (studio.ownerId === req.userId) {
          throw bookingError(403, 'You cannot book your own studio');
        }

        const bookingDetails = validateBookingDetails(studio, req.body);
        const lockResult = await studios.updateOne(
          {
            _id: studio._id,
            status: { $in: ['active', 'published'] },
          },
          { $inc: { bookingRevision: 1 } },
          { session },
        );
        if (lockResult.matchedCount !== 1) {
          throw bookingError(409, 'This studio is no longer available');
        }

        const overlap = await bookings.findOne(
          {
            studioId,
            bookingDate: bookingDetails.bookingDate,
            status: { $in: BOOKING_OVERLAP_STATUSES },
            startTime: { $lt: bookingDetails.endTime },
            endTime: { $gt: bookingDetails.startTime },
          },
          { session },
        );
        if (overlap) {
          throw bookingError(409, 'This studio already has a booking during that time');
        }

        const now = new Date();
        createdBooking = {
          _id: new ObjectId(),
          ...bookingDetails,
          renterId: req.userId,
          userId: req.userId,
          renterName: cleanText(req.authUser.name) || cleanText(req.authUser.email) || 'Renter',
          status: 'Pending',
          createdAt: now,
          updatedAt: now,
        };
        await bookings.insertOne(createdBooking, { session });

        const bookingDate = formatBookingNotificationDate(createdBooking);
        await insertNotification(
          bookingDetails.ownerId,
          {
            type: 'request',
            title: 'New booking request',
            body: `${createdBooking.renterName} requested ${createdBooking.studioName} for ${bookingDate} at ${createdBooking.startTime}.`,
            href: '/host/bookings-request',
          },
          session,
        );
        await insertNotification(
          req.userId,
          {
            type: 'booking',
            title: 'Booking request sent',
            body: `Your request for ${createdBooking.studioName} on ${bookingDate} at ${createdBooking.startTime} was sent to the host.`,
            href: '/dashboard/bookings',
          },
          session,
        );
      });

      return sendSuccess(res, {
        status: 201,
        message: 'Booking request sent',
        data: serializeRecord(createdBooking),
      });
    } finally {
      await session.endSession();
    }
  }, 'Failed to create booking'),
);

/**
 * PATCH /api/bookings/:id/status
 * Apply a status transition authorized by the session's renter/host role.
 */
app.patch(
  '/api/bookings/:id/status',
  requireSession,
  withBookingErrorHandling(async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      return sendError(res, 404, 'Booking not found');
    }

    const nextStatus = req.body?.status;
    if (typeof nextStatus !== 'string' || !BOOKING_STATUSES.has(nextStatus)) {
      return sendError(res, 400, 'Booking status is invalid');
    }

    const bookingId = new ObjectId(req.params.id);
    const session = client.startSession();
    let updatedBooking;
    try {
      await session.withTransaction(async () => {
        const current = await bookings.findOne(
          {
            _id: bookingId,
            ...bookingParticipantFilter(req.userId),
          },
          { session },
        );
        if (!current) throw bookingError(404, 'Booking not found');

        const isHost = current.ownerId === req.userId;
        const isRenter = current.renterId === req.userId || current.userId === req.userId;
        const allowedTransition = isHost
          ? (current.status === 'Pending' && ['Confirmed', 'Rejected'].includes(nextStatus)) ||
            (current.status === 'Confirmed' && nextStatus === 'Completed')
          : isRenter &&
            ['Pending', 'Confirmed'].includes(current.status) &&
            nextStatus === 'Cancelled';

        if (!allowedTransition) {
          throw bookingError(
            isHost || isRenter ? 409 : 403,
            'This booking cannot be changed to that status',
          );
        }

        if (isHost && nextStatus === 'Confirmed') {
          if (!isValidObjectId(current.studioId)) {
            throw bookingError(409, 'This studio is no longer available');
          }

          const studioObjectId = new ObjectId(current.studioId);
          const lockResult = await studios.updateOne(
            {
              _id: studioObjectId,
              ownerId: req.userId,
              status: { $in: ['active', 'published'] },
            },
            { $inc: { bookingRevision: 1 } },
            { session },
          );
          if (lockResult.matchedCount !== 1) {
            throw bookingError(409, 'This studio is no longer available');
          }

          const overlap = await bookings.findOne(
            {
              _id: { $ne: bookingId },
              studioId: current.studioId,
              bookingDate: current.bookingDate,
              status: { $in: BOOKING_OVERLAP_STATUSES },
              startTime: { $lt: current.endTime },
              endTime: { $gt: current.startTime },
            },
            { session },
          );
          if (overlap) {
            throw bookingError(409, 'Another active booking overlaps this request');
          }
        }

        const now = new Date();
        const result = await bookings.updateOne(
          { _id: bookingId, status: current.status },
          { $set: { status: nextStatus, updatedAt: now } },
          { session },
        );
        if (result.modifiedCount !== 1) {
          throw bookingError(409, 'This booking has already changed');
        }

        updatedBooking = {
          ...current,
          status: nextStatus,
          updatedAt: now,
        };

        const notificationRecipient = isHost ? current.renterId || current.userId : current.ownerId;
        const studioName = cleanText(current.studioName) || 'your studio';
        const bookingDate = formatBookingNotificationDate(current);
        const statusNotification = {
          Confirmed: {
            type: 'booking',
            title: 'Booking confirmed',
            body: `Your booking for ${studioName} on ${bookingDate} at ${current.startTime} was confirmed.`,
          },
          Rejected: {
            type: 'cancelled',
            title: 'Booking declined',
            body: `The host declined your booking for ${studioName} on ${bookingDate}.`,
          },
          Completed: {
            type: 'booking',
            title: 'Booking completed',
            body: `Your booking for ${studioName} on ${bookingDate} was marked complete.`,
          },
          Cancelled: {
            type: 'cancelled',
            title: 'Booking cancelled',
            body: `${cleanText(current.renterName) || 'The renter'} cancelled the booking for ${studioName} on ${bookingDate}.`,
          },
        }[nextStatus];

        await insertNotification(
          notificationRecipient,
          {
            ...statusNotification,
            href: isHost ? '/dashboard/bookings' : '/host/bookings-request',
          },
          session,
        );
      });

      return sendSuccess(res, {
        message: 'Booking updated',
        data: serializeRecord(updatedBooking),
      });
    } finally {
      await session.endSession();
    }
  }, 'Failed to update booking'),
);

/**
 * GET /api/reviews/eligibility?studioId=<id>
 * Return the latest completed, not-yet-reviewed booking for the signed-in user.
 */
app.get(
  '/api/reviews/eligibility',
  requireSession,
  withApiErrorHandling(async (req, res) => {
    const studioId = typeof req.query.studioId === 'string' ? req.query.studioId.trim() : '';
    if (!isValidObjectId(studioId)) {
      return sendError(res, 400, 'Studio id is invalid');
    }

    const [studio, completedBookings, existingReviews] = await Promise.all([
      studios.findOne({ _id: new ObjectId(studioId) }, { projection: { _id: 1 } }),
      bookings
        .find({
          studioId,
          status: 'Completed',
          ...renterBookingFilter(req.userId),
        })
        .project({ _id: 1, bookingDate: 1, endTime: 1, createdAt: 1 })
        .sort({ bookingDate: -1, createdAt: -1 })
        .toArray(),
      reviews.find({ studioId, userId: req.userId }).project({ bookingId: 1 }).toArray(),
    ]);

    if (!studio) return sendError(res, 404, 'Studio not found');

    const reviewedBookingIds = new Set(existingReviews.map((review) => review.bookingId));
    const eligibleBooking = completedBookings.find(
      (booking) => bookingHasEnded(booking) && !reviewedBookingIds.has(String(booking._id)),
    );

    return sendSuccess(res, {
      message: 'Review eligibility loaded',
      data: {
        canReview: Boolean(eligibleBooking),
        bookingId: eligibleBooking ? String(eligibleBooking._id) : null,
        bookingDate: eligibleBooking?.bookingDate || null,
      },
    });
  }, 'Failed to load review eligibility'),
);

/**
 * GET /api/reviews?studioId=<id>
 * Return public review fields, optionally narrowed to a studio.
 */
app.get(
  '/api/reviews',
  withApiErrorHandling(async (req, res) => {
    const studioId = typeof req.query.studioId === 'string' ? req.query.studioId.trim() : '';

    if (studioId.length > 128) {
      return sendError(res, 400, 'Studio id is too long');
    }

    const data = await reviews
      .find(studioId ? { studioId } : {})
      .sort({ createdAt: -1 })
      .toArray();
    return sendSuccess(res, {
      message: 'Reviews loaded',
      data: data.map(serializeReview),
    });
  }, 'Failed to load reviews'),
);

/**
 * POST /api/reviews
 * Create a review only for a completed booking owned by the session user.
 */
app.post(
  '/api/reviews',
  requireSession,
  withBookingErrorHandling(
    async (req, res) => {
      const studioId = typeof req.body?.studioId === 'string' ? req.body.studioId.trim() : '';
      const bookingId = typeof req.body?.bookingId === 'string' ? req.body.bookingId.trim() : '';
      const rating = req.body?.rating;
      const comment = cleanText(req.body?.comment);

      if (!isValidObjectId(studioId) || !isValidObjectId(bookingId)) {
        return sendError(res, 400, 'Studio or booking id is invalid');
      }
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return sendError(res, 400, 'Choose a rating from 1 to 5 stars');
      }
      if (!comment || comment.length > REVIEW_COMMENT_MAX_LENGTH) {
        return sendError(
          res,
          400,
          `Review text must be between 1 and ${REVIEW_COMMENT_MAX_LENGTH} characters`,
        );
      }

      const session = client.startSession();
      let createdReview;
      try {
        await session.withTransaction(async () => {
          const completedBooking = await bookings.findOne(
            {
              _id: new ObjectId(bookingId),
              studioId,
              status: 'Completed',
              ...renterBookingFilter(req.userId),
            },
            {
              session,
              projection: { _id: 1, bookingDate: 1, endTime: 1 },
            },
          );
          if (!completedBooking) {
            throw bookingError(
              403,
              'A completed booking for this studio is required to leave a review',
            );
          }
          if (!bookingHasEnded(completedBooking)) {
            throw bookingError(403, 'Reviews are available after the booking has ended');
          }

          const studio = await studios.findOne({ _id: new ObjectId(studioId) }, { session });
          if (!studio) throw bookingError(404, 'Studio not found');

          const now = new Date();
          createdReview = {
            _id: new ObjectId(),
            studioId,
            bookingId,
            userId: req.userId,
            reviewerName: cleanText(req.authUser.name).slice(0, 80) || 'SetSpace user',
            rating,
            comment,
            createdAt: now,
            updatedAt: now,
          };
          await reviews.insertOne(createdReview, { session });

          const reviewCount = Number(studio.reviewCount) || 0;
          const storedRatingTotal = Number(studio.ratingTotal);
          const previousRatingTotal = Number.isFinite(storedRatingTotal)
            ? storedRatingTotal
            : (Number(studio.rating) || 0) * reviewCount;
          const nextReviewCount = reviewCount + 1;
          const nextRatingTotal = previousRatingTotal + rating;
          const nextRating = Math.round((nextRatingTotal / nextReviewCount) * 10) / 10;

          await studios.updateOne(
            { _id: studio._id },
            {
              $set: {
                rating: nextRating,
                reviewCount: nextReviewCount,
                ratingTotal: nextRatingTotal,
                updatedAt: now,
              },
            },
            { session },
          );

          await insertNotification(
            studio.ownerId,
            {
              type: 'review',
              title: `New ${rating}-star review`,
              body: `${createdReview.reviewerName} left a review for ${cleanText(studio.name) || 'your studio'}.`,
              href: `/explore-studio/${studioId}#reviews`,
            },
            session,
          );
        });

        return sendSuccess(res, {
          status: 201,
          message: 'Review posted',
          data: serializeReview(createdReview),
        });
      } finally {
        await session.endSession();
      }
    },
    'Failed to create review',
    'A review has already been posted for this booking',
  ),
);

/* ------------------------------------------------------------------ */
/* 7. Notifications API                                                */
/* ------------------------------------------------------------------ */

app.get(
  '/api/notifications',
  requireSession,
  withApiErrorHandling(async (req, res) => {
    const data = await notifications.find({ userId: req.userId }).sort({ createdAt: -1 }).toArray();
    return sendSuccess(res, {
      message: 'Notifications loaded',
      data: data.map(serializeNotification),
    });
  }, 'Failed to load notifications'),
);

app.patch(
  '/api/notifications/read-all',
  requireSession,
  withApiErrorHandling(
    async (req, res) => {
      const result = await notifications.updateMany(
        { userId: req.userId, isRead: { $ne: true } },
        { $set: { isRead: true, readAt: new Date() } },
      );
      return sendSuccess(res, {
        message: 'Notifications marked as read',
        data: { updated: result.modifiedCount },
      });
    },
    'Failed to update notifications',
    {
      logMessage: 'Failed to mark all notifications as read:',
    },
  ),
);

app.patch(
  '/api/notifications/:id/read',
  requireSession,
  withApiErrorHandling(
    async (req, res) => {
      if (!isValidObjectId(req.params.id)) {
        return sendError(res, 404, 'Notification not found');
      }

      const result = await notifications.updateOne(
        { _id: new ObjectId(req.params.id), userId: req.userId },
        { $set: { isRead: true, readAt: new Date() } },
      );
      if (!result.matchedCount) {
        return sendError(res, 404, 'Notification not found');
      }

      return sendSuccess(res, { message: 'Notification marked as read' });
    },
    'Failed to update notification',
    {
      logMessage: 'Failed to mark notification as read:',
    },
  ),
);

app.delete(
  '/api/notifications/:id',
  requireSession,
  withApiErrorHandling(async (req, res) => {
    if (!isValidObjectId(req.params.id)) {
      return sendError(res, 404, 'Notification not found');
    }

    const result = await notifications.deleteOne({
      _id: new ObjectId(req.params.id),
      userId: req.userId,
    });
    if (!result.deletedCount) {
      return sendError(res, 404, 'Notification not found');
    }
    return sendSuccess(res, { message: 'Notification deleted' });
  }, 'Failed to delete notification'),
);

/* ------------------------------------------------------------------ */
/* 8. User Profile API                                                 */
/* ------------------------------------------------------------------ */

/**
 * GET /api/profile
 * Return the signed-in user's profile, auth user and account stats.
 */
app.get(
  '/api/profile',
  requireSession,
  withProfileErrorHandling(
    async (req, res) => {
      let profile = await findProfile(req.userId);

      if (!profile) {
        return sendProfileError(res, 404, 'Profile not found', 'PROFILE_NOT_FOUND');
      }

      // Email belongs to Better Auth. Keep the profile copy in sync with the
      // verified session instead of trusting a stored email.
      const email = cleanText(req.authUser.email);
      if (email && profile.email !== email) {
        await userProfiles.updateOne(
          { _id: profile._id },
          { $set: { email, updatedAt: new Date() } },
        );
        profile = { ...profile, email };
      }

      const stats = await getProfileStats(req.userId, req.authUser);

      return res.json({
        profile: serializeProfile(profile, req.authUser),
        user: serializeUser(req.authUser),
        stats,
      });
    },
    'Failed to get profile:',
    'Failed to load your profile',
    'PROFILE_LOAD_FAILED',
  ),
);

/**
 * GET /api/profile/image
 * Return the signed-in user's stored profile image.
 */
app.get(
  '/api/profile/image',
  requireSession,
  withProfileErrorHandling(
    async (req, res) => {
      const profile = await userProfiles.findOne(
        { userId: req.userId },
        { projection: { imageData: 1, imageContentType: 1 } },
      );

      if (typeof profile?.imageData !== 'string' || !profile.imageData) {
        return sendProfileError(res, 404, 'Profile image not found', 'PROFILE_IMAGE_NOT_FOUND');
      }

      const image = Buffer.from(profile.imageData, 'base64');
      const normalizedImage = normalizeImageBuffer(image);
      if (!normalizedImage || image.length > PROFILE_IMAGE_MAX_BYTES) {
        return sendProfileError(res, 404, 'Profile image not found', 'PROFILE_IMAGE_NOT_FOUND');
      }

      res.set({
        'Cache-Control': 'private, no-store',
        'Content-Length': String(normalizedImage.buffer.length),
        'Content-Type': normalizedImage.contentType,
        'X-Content-Type-Options': 'nosniff',
      });
      if (normalizedImage.contentType === 'image/svg+xml') {
        res.set('Content-Security-Policy', "default-src 'none'; sandbox");
      }
      return res.send(normalizedImage.buffer);
    },
    'Failed to load profile image:',
    'Failed to load your profile image',
    'PROFILE_IMAGE_LOAD_FAILED',
  ),
);

/**
 * PUT /api/profile/image
 * Persist a validated image with the signed-in user's profile.
 */
app.put(
  '/api/profile/image',
  requireSession,
  handleProfileImageBody,
  withProfileErrorHandling(
    async (req, res) => {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return sendProfileError(
          res,
          400,
          'A profile image file is required',
          'PROFILE_IMAGE_REQUIRED',
        );
      }

      if (req.body.length > PROFILE_IMAGE_MAX_BYTES) {
        return sendProfileError(
          res,
          413,
          'Profile image must be 1 MB or smaller',
          'PROFILE_IMAGE_TOO_LARGE',
        );
      }

      const normalizedImage = normalizeImageBuffer(req.body);
      if (!normalizedImage) {
        return sendProfileError(
          res,
          415,
          'Use a valid JPEG, PNG, WebP, GIF or SVG profile image',
          'INVALID_PROFILE_IMAGE',
        );
      }

      const now = new Date();
      const update = {
        $set: {
          email: cleanText(req.authUser.email),
          image: '/api/profile/image',
          imageData: normalizedImage.buffer.toString('base64'),
          imageContentType: normalizedImage.contentType,
          imageUpdatedAt: now,
          imageVersion: new ObjectId().toString(),
          updatedAt: now,
        },
        $setOnInsert: {
          userId: req.userId,
          name: nameFromSession(req.authUser),
          createdAt: now,
        },
      };

      let created = false;
      try {
        const result = await userProfiles.updateOne({ userId: req.userId }, update, {
          upsert: true,
        });
        created = result.upsertedCount > 0;
      } catch (error) {
        if (error?.code !== 11000) throw error;
        await userProfiles.updateOne({ userId: req.userId }, update);
      }

      const profile = await findProfile(req.userId);
      return res.status(created ? 201 : 200).json({
        profile: serializeProfile(profile, req.authUser),
        created,
      });
    },
    'Failed to save profile image:',
    'Failed to save your profile image',
    'PROFILE_IMAGE_SAVE_FAILED',
  ),
);

/**
 * POST /api/profile
 * Create the profile if it does not exist. Safe to call more than once:
 * the unique userId index plus this upsert prevent duplicates.
 */
app.post(
  '/api/profile',
  requireSession,
  withProfileErrorHandling(
    async (req, res) => {
      const { errors, values } = validateProfileBody(req.body ?? {}, {
        allowEmpty: true,
      });

      if (errors.length) {
        return sendProfileError(res, 400, errors[0], 'VALIDATION_ERROR', {
          errors,
        });
      }

      const existing = await findProfile(req.userId);
      if (existing) {
        return res.json({
          profile: serializeProfile(existing, req.authUser),
          created: false,
        });
      }

      const now = new Date();
      const document = {
        userId: req.userId,
        name: values.name ?? nameFromSession(req.authUser),
        email: cleanText(req.authUser.email),
        image: values.image === '' ? null : (values.image ?? req.authUser.image ?? null),
        createdAt: now,
        updatedAt: now,
      };

      for (const field of ['phone', 'location', 'bio']) {
        if (values[field]) document[field] = values[field];
      }

      try {
        await userProfiles.insertOne(document);

        return res.status(201).json({
          profile: serializeProfile(document, req.authUser),
          created: true,
        });
      } catch (error) {
        // A concurrent request created it first. Return that profile instead
        // of producing a duplicate or a confusing error.
        if (error?.code === 11000) {
          const profile = await findProfile(req.userId);

          return res.json({
            profile: serializeProfile(profile, req.authUser),
            created: false,
          });
        }

        throw error;
      }
    },
    'Failed to create profile:',
    'Failed to create your profile',
    'PROFILE_CREATE_FAILED',
  ),
);

/**
 * PATCH /api/profile (and PUT for clients that prefer it)
 * Update existing fields, fill empty fields, or clear a field by sending an
 * empty string. Creates the profile if it is missing.
 */
const updateProfileHandler = withProfileErrorHandling(
  async (req, res) => {
    const { errors, values } = validateProfileBody(req.body ?? {});

    if (errors.length) {
      return sendProfileError(res, 400, errors[0], 'VALIDATION_ERROR', {
        errors,
      });
    }

    const now = new Date();
    const update = buildProfileUpdate(values, {
      userId: req.userId,
      authUser: req.authUser,
      now,
    });

    let result;

    try {
      result = await userProfiles.updateOne({ userId: req.userId }, update, {
        upsert: true,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;

      // Another request inserted the profile between our read and write.
      result = await userProfiles.updateOne({ userId: req.userId }, update);
    }

    const profile = await findProfile(req.userId);

    return res.status(result.upsertedCount > 0 ? 201 : 200).json({
      profile: serializeProfile(profile, req.authUser),
      created: result.upsertedCount > 0,
    });
  },
  'Failed to update profile:',
  'Failed to update your profile',
  'PROFILE_UPDATE_FAILED',
);

app.patch('/api/profile', requireSession, updateProfileHandler);
app.put('/api/profile', requireSession, updateProfileHandler);

/**
 * DELETE /api/profile
 * Delete the SetSpace profile document only. Better Auth's user, session,
 * account and verification collections are never touched.
 */
app.delete(
  '/api/profile',
  requireSession,
  withProfileErrorHandling(
    async (req, res) => {
      const result = await userProfiles.deleteOne({ userId: req.userId });
      return res.json({
        success: true,
        deleted: result.deletedCount > 0,
      });
    },
    'Failed to delete profile:',
    'Failed to delete your profile',
    'PROFILE_DELETE_FAILED',
  ),
);

/**
 * DELETE /api/profile/fields/:field
 * Clear one editable field without deleting the whole profile.
 * Name and email are intentionally not deletable: the name is required and
 * email is owned by Better Auth.
 */
app.delete(
  '/api/profile/fields/:field',
  requireSession,
  withProfileErrorHandling(
    async (req, res) => {
      const field = String(req.params.field || '').toLowerCase();

      if (!DELETABLE_FIELDS.has(field)) {
        return sendProfileError(
          res,
          400,
          `Field must be one of: ${[...DELETABLE_FIELDS].join(', ')}`,
          'INVALID_FIELD',
        );
      }

      const unset = { [field]: '' };
      if (field === 'image') {
        clearProfileImageFields(unset);
      }

      const result = await userProfiles.updateOne(
        { userId: req.userId },
        {
          $unset: unset,
          $set: { updatedAt: new Date() },
        },
      );

      if (!result.matchedCount) {
        return sendProfileError(res, 404, 'Profile not found', 'PROFILE_NOT_FOUND');
      }

      const profile = await findProfile(req.userId);
      return res.json({ profile: serializeProfile(profile, req.authUser) });
    },
    'Failed to clear profile field:',
    'Failed to clear this profile field',
    'PROFILE_FIELD_DELETE_FAILED',
  ),
);

/* ------------------------------------------------------------------ */
/* 8. Existing account route                                           */
/* ------------------------------------------------------------------ */

// Get the signed-in user's Better Auth account. `/users/me` is supported as
// a convenience, and a real id is only accepted when it belongs to the
// caller. Profile data is served by /api/profile.
app.get(
  '/users/:id',
  requireSession,
  withProfileErrorHandling(
    async (req, res) => {
      const requestedId = req.params.id === 'me' ? req.userId : req.params.id;

      if (requestedId !== req.userId) {
        return sendProfileError(res, 403, 'You can only access your own account', 'FORBIDDEN');
      }

      const query = ObjectId.isValid(requestedId)
        ? { _id: new ObjectId(requestedId) }
        : { _id: requestedId };

      const user = await authUsers.findOne(query);

      if (!user) {
        return sendProfileError(res, 404, 'User not found', 'USER_NOT_FOUND');
      }

      return res.json({
        id: String(user._id),
        name: user.name ?? '',
        email: user.email ?? '',
        image: user.image ?? null,
        emailVerified: Boolean(user.emailVerified),
        createdAt: user.createdAt ?? null,
      });
    },
    'Error fetching user:',
    'Internal Server Error',
    'USER_LOAD_FAILED',
  ),
);

/* ------------------------------------------------------------------ */
/* 9. Health route and error handling                                  */
/* ------------------------------------------------------------------ */

app.get('/', (req, res) => {
  res.send('Hello World!');
});

/**
 * GET /api/health
 * Confirms both databases respond. Does not return credentials, documents,
 * or internal error details.
 */
app.get('/api/health', async (req, res) => {
  try {
    const [authPing, setSpacePing] = await Promise.all([
      authDb.command({ ping: 1 }),
      setSpaceDb.command({ ping: 1 }),
    ]);

    const setSpaceNames = (await setSpaceDb.listCollections({}, { nameOnly: true }).toArray()).map(
      (collection) => collection.name,
    );

    const missing = APPLICATION_COLLECTIONS.filter((name) => !setSpaceNames.includes(name));

    const healthy =
      authPing?.ok === 1 && setSpacePing?.ok === 1 && databaseReady && missing.length === 0;

    if (!healthy) {
      return sendError(res, 503, 'Database foundation is not ready');
    }

    return sendSuccess(res, {
      message: 'Both databases are connected',
      data: {
        auth: { name: AUTH_DB_NAME, ok: true },
        setspace: {
          name: SETSPACE_DB_NAME,
          ok: true,
          collections: APPLICATION_COLLECTIONS,
        },
      },
    });
  } catch (error) {
    console.error('Health check failed:', error?.message || error);
    return sendError(res, 503, 'Database foundation is not ready');
  }
});

app.use((req, res) => {
  return res.status(404).json({
    error: 'Route not found',
    code: 'NOT_FOUND',
  });
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'Invalid JSON body',
      code: 'INVALID_JSON',
    });
  }

  if (error?.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Request body is too large',
      code: 'PAYLOAD_TOO_LARGE',
    });
  }

  console.error('Unhandled error:', error);
  return res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`SetSpace API listening on port ${port}`);
    console.log(`Better Auth session verification: ${SESSION_ENDPOINT}`);
    console.log(
      `Profile storage: ${SETSPACE_DB_NAME}.${USER_PROFILES_COLLECTION} (auth data stays in ${AUTH_DB_NAME})`,
    );
  });
}

export default app;