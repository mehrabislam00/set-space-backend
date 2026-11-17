import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';

const app = express();
const port = Number(process.env.PORT) || 5000;

/* ------------------------------------------------------------------ */
/* 1. Configuration                                                    */
/* ------------------------------------------------------------------ */

const username = process.env.MONGODB_USERNAME;
const password = process.env.MONGODB_PASSWORD;

if (!username || !password) {
  throw new Error('MONGODB_USERNAME and MONGODB_PASSWORD must be configured');
}

// Better Auth and this API share the same cluster. Authentication data
// stays in the `auth` database; application data stays in `SetSpace`.
const mongoUri = `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@ac-tikzacb-shard-00-00.rbwczib.mongodb.net:27017,ac-tikzacb-shard-00-01.rbwczib.mongodb.net:27017,ac-tikzacb-shard-00-02.rbwczib.mongodb.net:27017/?ssl=true&replicaSet=atlas-11uhlz-shard-0&authSource=admin`;

const AUTH_DB_NAME = process.env.AUTH_DB_NAME?.trim() || 'auth';
const SETSPACE_DB_NAME = process.env.SETSPACE_DB_NAME?.trim() || 'SetSpace';
const USER_PROFILES_COLLECTION = 'userProfiles';
const PROFILE_BIO_MAX = 280;

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

const allowedOrigins = (
  process.env.CLIENT_URI || 'http://localhost:3000,http://127.0.0.1:3000'
)
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
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
    optionsSuccessStatus: 204,
  })
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

app.use(express.json({ limit: '100kb' }));

/* ------------------------------------------------------------------ */
/* 3. MongoDB connection                                               */
/* ------------------------------------------------------------------ */

const client = new MongoClient(mongoUri);

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

const ConnectedClient = await connectToMongoDB();

const setSpaceDb = ConnectedClient.db(SETSPACE_DB_NAME);
const authDb = ConnectedClient.db(AUTH_DB_NAME);

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

const userProfiles = setSpaceDb.collection(USER_PROFILES_COLLECTION);
const studios = setSpaceDb.collection('studios');
const bookings = setSpaceDb.collection('bookings');
const reviews = setSpaceDb.collection('reviews');
const wishlists = setSpaceDb.collection('wishlists');
const notifications = setSpaceDb.collection('notifications');
const contactMessages = setSpaceDb.collection('contactMessages');
const newsletterSubscribers = setSpaceDb.collection('newsletterSubscribers');

// Better Auth data (auth database). Read-only here: Better Auth owns it.
const authUsers = authDb.collection('user');

const db = {
  client: ConnectedClient,
  auth: authDb,
  setSpace: setSpaceDb,
  userProfiles,
  studios,
  bookings,
  reviews,
  wishlists,
  notifications,
  contactMessages,
  newsletterSubscribers,
  authUsers,
};

/** True only for a 24-character hex ObjectId string. */
function isValidObjectId(value) {
  if (typeof value !== 'string' || !ObjectId.isValid(value)) return false;
  return String(new ObjectId(value)) === value;
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

/**
 * Create a collection only when it is missing. Existing documents, including
 * userProfiles written by the profile API, are left in place.
 */
async function ensureApplicationCollections() {
  const existing = new Set(
    (await setSpaceDb.listCollections({}, { nameOnly: true }).toArray()).map(
      (collection) => collection.name
    )
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
        options?.name || JSON.stringify(keys)
      );
      return;
    }

    throw error;
  }
}

async function ensureApplicationIndexes() {
  await Promise.all([
    createIndex(userProfiles, { userId: 1 }, { unique: true, name: 'userId_unique' }),

    createIndex(
      studios,
      { slug: 1 },
      {
        unique: true,
        name: 'slug_unique',
        partialFilterExpression: { slug: { $gt: '' } },
      }
    ),
    createIndex(studios, { ownerId: 1 }, { name: 'ownerId' }),
    createIndex(studios, { status: 1 }, { name: 'status' }),
    createIndex(
      studios,
      { status: 1, featured: 1, createdAt: -1 },
      { name: 'status_featured_createdAt' }
    ),

    createIndex(bookings, { renterId: 1, createdAt: -1 }, { name: 'renterId_createdAt' }),
    createIndex(bookings, { ownerId: 1, createdAt: -1 }, { name: 'ownerId_createdAt' }),
    createIndex(
      bookings,
      { studioId: 1, bookingDate: 1, status: 1 },
      { name: 'studioId_bookingDate_status' }
    ),

    createIndex(reviews, { studioId: 1, createdAt: -1 }, { name: 'studioId_createdAt' }),
    createIndex(reviews, { userId: 1, createdAt: -1 }, { name: 'userId_createdAt' }),
    createIndex(
      reviews,
      { bookingId: 1 },
      {
        unique: true,
        name: 'bookingId_unique',
        partialFilterExpression: { bookingId: { $gt: '' } },
      }
    ),

    createIndex(wishlists, { userId: 1 }, { unique: true, name: 'userId_unique' }),

    createIndex(
      notifications,
      { userId: 1, createdAt: -1 },
      { name: 'userId_createdAt' }
    ),
    createIndex(
      notifications,
      { userId: 1, isRead: 1, createdAt: -1 },
      { name: 'userId_isRead_createdAt' }
    ),

    createIndex(contactMessages, { createdAt: -1 }, { name: 'createdAt' }),
    createIndex(
      contactMessages,
      { status: 1, createdAt: -1 },
      { name: 'status_createdAt' }
    ),

    createIndex(
      newsletterSubscribers,
      { email: 1 },
      { unique: true, name: 'email_unique' }
    ),
  ]);
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
    const existing = new Set(
      (await collection.indexes()).map((index) => index.name)
    );

    for (const indexName of indexNames) {
      if (!existing.has(indexName)) continue;
      await collection.dropIndex(indexName);
      console.log(`Dropped stale index ${name}.${indexName}`);
    }
  }
}

let databaseReady = false;

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
    }`
  );
  console.log(
    `SetSpace database "${SETSPACE_DB_NAME}" is reachable. Collections: ${setSpaceNames
      .map((collection) => collection.name)
      .join(', ')}`
  );
}

try {
  await setupDatabases();
} catch (error) {
  console.error(
    'Database foundation setup failed:',
    error?.message || 'Database setup failed'
  );
}

/* ------------------------------------------------------------------ */
/* 4. Authentication                                                   */
/* ------------------------------------------------------------------ */

/**
 * Ask the Better Auth server who owns the incoming cookies. This reuses the
 * existing Next.js Better Auth configuration (secret, cookie names, adapter)
 * instead of maintaining a second copy of the auth setup in this service.
 */
async function getBetterAuthSession(req) {
  if (!req.headers.cookie && !req.headers.authorization) {
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const headers = {
      accept: 'application/json',
      origin: AUTH_ORIGIN,
    };

    if (req.headers.cookie) headers.cookie = req.headers.cookie;
    if (req.headers.authorization) {
      headers.authorization = req.headers.authorization;
    }

    const response = await fetch(SESSION_ENDPOINT, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Better Auth session endpoint returned ${response.status}`
      );
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

    req.auth = session;
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

  return {
    id: profile._id ? String(profile._id) : String(profile.userId),
    userId: String(profile.userId),
    name: cleanText(profile.name) || nameFromSession(authUser),
    email: cleanText(profile.email) || cleanText(authUser?.email),
    phone: profile.phone ?? '',
    location: profile.location ?? '',
    bio: profile.bio ?? '',
    image: profile.image ?? authUser?.image ?? null,
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
        errors.push(
          `Phone must be ${PROFILE_LIMITS.phone} characters or fewer.`
        );
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
        errors.push(
          `Location must be ${PROFILE_LIMITS.location} characters or fewer.`
        );
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
        errors.push(
          `Bio must be ${PROFILE_LIMITS.bio} characters or fewer.`
        );
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
        errors.push(
          `Image URL must be ${PROFILE_LIMITS.image} characters or fewer.`
        );
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

async function getProfileStats(userId, authUser) {
  const safeCount = (promise) =>
    promise.catch((error) => {
      console.error('Profile stats query failed:', error?.message || error);
      return 0;
    });

  const [bookingCount, listingCount] = await Promise.all([
    safeCount(
      bookings.countDocuments({
        $or: [{ renterId: userId }, { userId }],
      })
    ),
    safeCount(studios.countDocuments({ ownerId: userId })),
  ]);

  const accountCreatedAt = authUser?.createdAt
    ? new Date(authUser.createdAt)
    : null;
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

/* ------------------------------------------------------------------ */
/* 6. User Profile API                                                 */
/* ------------------------------------------------------------------ */

/**
 * GET /api/profile
 * Return the signed-in user's profile, auth user and account stats.
 */
app.get('/api/profile', requireSession, async (req, res) => {
  try {
    let profile = await userProfiles.findOne({ userId: req.userId });

    if (!profile) {
      return res.status(404).json({
        error: 'Profile not found',
        code: 'PROFILE_NOT_FOUND',
      });
    }

    // Email belongs to Better Auth. Keep the profile copy in sync with the
    // verified session instead of trusting a stored email.
    const email = cleanText(req.authUser.email);
    if (email && profile.email !== email) {
      await userProfiles.updateOne(
        { _id: profile._id },
        { $set: { email, updatedAt: new Date() } }
      );
      profile = { ...profile, email };
    }

    const stats = await getProfileStats(req.userId, req.authUser);

    return res.json({
      profile: serializeProfile(profile, req.authUser),
      user: serializeUser(req.authUser),
      stats,
    });
  } catch (error) {
    console.error('Failed to get profile:', error);
    return res.status(500).json({
      error: 'Failed to load your profile',
      code: 'PROFILE_LOAD_FAILED',
    });
  }
});

/**
 * POST /api/profile
 * Create the profile if it does not exist. Safe to call more than once:
 * the unique userId index plus this upsert prevent duplicates.
 */
app.post('/api/profile', requireSession, async (req, res) => {
  try {
    const { errors, values } = validateProfileBody(req.body ?? {}, {
      allowEmpty: true,
    });

    if (errors.length) {
      return res.status(400).json({
        error: errors[0],
        errors,
        code: 'VALIDATION_ERROR',
      });
    }

    const existing = await userProfiles.findOne({ userId: req.userId });
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
      image:
        values.image === ''
          ? null
          : values.image ?? req.authUser.image ?? null,
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
        const profile = await userProfiles.findOne({ userId: req.userId });

        return res.json({
          profile: serializeProfile(profile, req.authUser),
          created: false,
        });
      }

      throw error;
    }
  } catch (error) {
    console.error('Failed to create profile:', error);
    return res.status(500).json({
      error: 'Failed to create your profile',
      code: 'PROFILE_CREATE_FAILED',
    });
  }
});

/**
 * PATCH /api/profile (and PUT for clients that prefer it)
 * Update existing fields, fill empty fields, or clear a field by sending an
 * empty string. Creates the profile if it is missing.
 */
async function updateProfileHandler(req, res) {
  try {
    const { errors, values } = validateProfileBody(req.body ?? {});

    if (errors.length) {
      return res.status(400).json({
        error: errors[0],
        errors,
        code: 'VALIDATION_ERROR',
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

    const profile = await userProfiles.findOne({ userId: req.userId });

    return res
      .status(result.upsertedCount > 0 ? 201 : 200)
      .json({
        profile: serializeProfile(profile, req.authUser),
        created: result.upsertedCount > 0,
      });
  } catch (error) {
    console.error('Failed to update profile:', error);
    return res.status(500).json({
      error: 'Failed to update your profile',
      code: 'PROFILE_UPDATE_FAILED',
    });
  }
}

app.patch('/api/profile', requireSession, updateProfileHandler);
app.put('/api/profile', requireSession, updateProfileHandler);

/**
 * DELETE /api/profile
 * Delete the SetSpace profile document only. Better Auth's user, session,
 * account and verification collections are never touched.
 */
app.delete('/api/profile', requireSession, async (req, res) => {
  try {
    const result = await userProfiles.deleteOne({ userId: req.userId });

    return res.json({
      success: true,
      deleted: result.deletedCount > 0,
    });
  } catch (error) {
    console.error('Failed to delete profile:', error);
    return res.status(500).json({
      error: 'Failed to delete your profile',
      code: 'PROFILE_DELETE_FAILED',
    });
  }
});

/**
 * DELETE /api/profile/fields/:field
 * Clear one editable field without deleting the whole profile.
 * Name and email are intentionally not deletable: the name is required and
 * email is owned by Better Auth.
 */
app.delete('/api/profile/fields/:field', requireSession, async (req, res) => {
  try {
    const field = String(req.params.field || '').toLowerCase();

    if (!DELETABLE_FIELDS.has(field)) {
      return res.status(400).json({
        error: `Field must be one of: ${[...DELETABLE_FIELDS].join(', ')}`,
        code: 'INVALID_FIELD',
      });
    }

    const result = await userProfiles.updateOne(
      { userId: req.userId },
      {
        $unset: { [field]: '' },
        $set: { updatedAt: new Date() },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).json({
        error: 'Profile not found',
        code: 'PROFILE_NOT_FOUND',
      });
    }

    const profile = await userProfiles.findOne({ userId: req.userId });

    return res.json({
      profile: serializeProfile(profile, req.authUser),
    });
  } catch (error) {
    console.error('Failed to clear profile field:', error);
    return res.status(500).json({
      error: 'Failed to clear this profile field',
      code: 'PROFILE_FIELD_DELETE_FAILED',
    });
  }
});

/* ------------------------------------------------------------------ */
/* 7. Existing account route                                           */
/* ------------------------------------------------------------------ */

// Get the signed-in user's Better Auth account. `/users/me` is supported as
// a convenience, and a real id is only accepted when it belongs to the
// caller. Profile data is served by /api/profile.
app.get('/users/:id', requireSession, async (req, res) => {
  try {
    const requestedId = req.params.id === 'me' ? req.userId : req.params.id;

    if (requestedId !== req.userId) {
      return res.status(403).json({
        error: 'You can only access your own account',
        code: 'FORBIDDEN',
      });
    }

    const query = ObjectId.isValid(requestedId)
      ? { _id: new ObjectId(requestedId) }
      : { _id: requestedId };

    const user = await authUsers.findOne(query);

    if (!user) {
      return res.status(404).json({
        error: 'User not found',
        code: 'USER_NOT_FOUND',
      });
    }

    return res.json({
      id: String(user._id),
      name: user.name ?? '',
      email: user.email ?? '',
      image: user.image ?? null,
      emailVerified: Boolean(user.emailVerified),
      createdAt: user.createdAt ?? null,
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    return res.status(500).json({
      error: 'Internal Server Error',
      code: 'USER_LOAD_FAILED',
    });
  }
});

/* ------------------------------------------------------------------ */
/* 8. Health route and error handling                                  */
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

    const setSpaceNames = (
      await setSpaceDb.listCollections({}, { nameOnly: true }).toArray()
    ).map((collection) => collection.name);

    const missing = APPLICATION_COLLECTIONS.filter(
      (name) => !setSpaceNames.includes(name)
    );

    const healthy =
      authPing?.ok === 1 &&
      setSpacePing?.ok === 1 &&
      databaseReady &&
      missing.length === 0;

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

app.listen(port, () => {
  console.log(`SetSpace API listening on port ${port}`);
  console.log(`Better Auth session verification: ${SESSION_ENDPOINT}`);
  console.log(
    `Profile storage: ${SETSPACE_DB_NAME}.${USER_PROFILES_COLLECTION} (auth data stays in ${AUTH_DB_NAME})`
  );
});
