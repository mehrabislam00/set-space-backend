
import "dotenv/config";
import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";

// --------------------------------------------------
// 1. EXPRESS SETUP
// --------------------------------------------------

const app = express();
const port = process.env.PORT || 5000;

app.use(express.json({ limit: "2mb" }));

app.use(
  cors({
    origin: process.env.CLIENT_URI,
    credentials: true,
  })
);

// --------------------------------------------------
// 2. MONGODB CONNECTION
// --------------------------------------------------

const mongoURI = process.env.MONGODB_URI;

if (!mongoURI) {
  throw new Error("MONGODB_URI must be configured");
}

const client = new MongoClient(mongoURI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("Successfully connected to MongoDB!");
    return client;
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    throw error;
  }
}

const ConnectedClient = await connectToMongoDB();

const db = ConnectedClient.db("set-space-db");
const authDb = ConnectedClient.db("auth");

// Better Auth collections - managed by Better Auth
const authUsersCollection = authDb.collection("user");
const authSessionsCollection = authDb.collection("session");
const authAccountsCollection = authDb.collection("account");
const authVerificationCollection = authDb.collection("verification");

// SetSpace application collections
const userProfilesCollection = db.collection("userProfiles");
const studiosCollection = db.collection("studios");
const bookingsCollection = db.collection("bookings");
const reviewsCollection = db.collection("reviews");
const wishlistsCollection = db.collection("wishlists");
const notificationsCollection = db.collection("notifications");
const contactMessagesCollection = db.collection("contactMessages");
const newsletterSubscribersCollection = db.collection(
  "newsletterSubscribers"
);

// --------------------------------------------------
// 3. AUTHENTICATION MIDDLEWARE
// --------------------------------------------------

if (!process.env.AUTH_JWKS_URL) {
  throw new Error("AUTH_JWKS_URL must be configured");
}

const JWKS = createRemoteJWKSet(
  new URL(process.env.AUTH_JWKS_URL)
);

const verifyUserId = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const [scheme, token] = authHeader?.split(/\s+/) ?? [];

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return res.status(401).send({
      error: "A Bearer authorization token is required",
    });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);

    if (!payload.sub) {
      return res.status(401).send({
        error: "Invalid user token",
      });
    }

    req.user = payload;
    req.userId = payload.sub;

    next();
  } catch (error) {
    console.error(
      "Token verification failed:",
      error.code ?? error.message
    );

    return res.status(401).send({
      error: "Invalid or expired token",
    });
  }
};

// --------------------------------------------------
// 4. HELPER FUNCTIONS
// --------------------------------------------------

const isValidObjectId = (id) => ObjectId.isValid(id);

const objectId = (id) => new ObjectId(id);

const escapeRegex = (value) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const createNotification = async ({
  userId,
  type,
  title,
  message,
  relatedData = {},
}) => {
  await notificationsCollection.insertOne({
    userId,
    type,
    title,
    message,
    relatedData,
    isRead: false,
    createdAt: new Date(),
  });
};

const getUserProfile = async (userId) => {
  return userProfilesCollection.findOne({ userId });
};

// --------------------------------------------------
// 5. TEST ROUTE
// --------------------------------------------------

app.get("/", (req, res) => {
  res.send("SetSpace API is running!");
});

// --------------------------------------------------
// 6. USER PROFILE ROUTES
// --------------------------------------------------

// Get current authenticated user's profile
app.get("/user/me", verifyUserId, async (req, res) => {
  try {
    const user = await authUsersCollection.findOne(
      { _id: req.userId },
      {
        projection: {
          _id: 1,
          name: 1,
          email: 1,
          image: 1,
          emailVerified: 1,
        },
      }
    );

    if (!user) {
      return res.status(404).send({
        error: "User not found",
      });
    }

    const profile = await getUserProfile(req.userId);

    res.send({
      ...user,
      id: user._id,
      profile,
    });
  } catch (error) {
    console.error("Failed to get user:", error);
    res.status(500).send({
      error: "Failed to load user profile",
    });
  }
});

// Create or update current user's profile
app.patch("/user/me", verifyUserId, async (req, res) => {
  try {
    const {
      phone,
      bio,
      location,
      preferences,
      notificationPreferences,
    } = req.body;

    const allowedFields = {
      phone,
      bio,
      location,
      preferences,
      notificationPreferences,
    };

    const profileUpdate = Object.fromEntries(
      Object.entries(allowedFields).filter(
        ([, value]) => value !== undefined
      )
    );

    if (!Object.keys(profileUpdate).length) {
      return res.status(400).send({
        error: "No profile fields provided",
      });
    }

    const now = new Date();

    await userProfilesCollection.updateOne(
      { userId: req.userId },
      {
        $set: {
          ...profileUpdate,
          updatedAt: now,
        },
        $setOnInsert: {
          userId: req.userId,
          roles: ["renter"],
          activeRole: "renter",
          createdAt: now,
        },
      },
      { upsert: true }
    );

    res.send({
      success: true,
      message: "Profile updated successfully",
    });
  } catch (error) {
    console.error("Profile update failed:", error);
    res.status(500).send({
      error: "Failed to update profile",
    });
  }
});

// --------------------------------------------------
// 7. STUDIO ROUTES
// --------------------------------------------------

// Get all published studios with filters
app.get("/studios", async (req, res) => {
  try {
    const {
      search,
      category,
      city,
      minPrice,
      maxPrice,
      rating,
      amenities,
      sort = "newest",
      page = "1",
      limit = "12",
    } = req.query;

    const filter = {
      status: "published",
    };

    if (category) {
      filter.category = category;
    }

    if (city) {
      filter["location.city"] = city;
    }

    if (minPrice || maxPrice) {
      filter["pricing.hourlyRate"] = {};

      if (minPrice) {
        filter["pricing.hourlyRate"].$gte = Number(minPrice);
      }

      if (maxPrice) {
        filter["pricing.hourlyRate"].$lte = Number(maxPrice);
      }
    }

    if (rating) {
      filter["rating.average"] = {
        $gte: Number(rating),
      };
    }

    if (amenities) {
      const selectedAmenities = amenities
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

      filter.amenities = {
        $all: selectedAmenities,
      };
    }

    if (search) {
      const safeSearch = escapeRegex(search);

      filter.$or = [
        { name: { $regex: safeSearch, $options: "i" } },
        { description: { $regex: safeSearch, $options: "i" } },
        { category: { $regex: safeSearch, $options: "i" } },
        { "location.city": { $regex: safeSearch, $options: "i" } },
      ];
    }

    const sortOptions = {
      newest: { createdAt: -1 },
      oldest: { createdAt: 1 },
      priceLow: { "pricing.hourlyRate": 1 },
      priceHigh: { "pricing.hourlyRate": -1 },
      rating: { "rating.average": -1 },
    };

    const currentPage = Math.max(1, Number(page) || 1);
    const currentLimit = Math.min(
      50,
      Math.max(1, Number(limit) || 12)
    );

    const skip = (currentPage - 1) * currentLimit;

    const [studios, total] = await Promise.all([
      studiosCollection
        .find(filter)
        .sort(sortOptions[sort] || sortOptions.newest)
        .skip(skip)
        .limit(currentLimit)
        .toArray(),

      studiosCollection.countDocuments(filter),
    ]);

    res.send({
      success: true,
      data: studios,
      pagination: {
        total,
        page: currentPage,
        limit: currentLimit,
        totalPages: Math.ceil(total / currentLimit),
      },
    });
  } catch (error) {
    console.error("Failed to get studios:", error);
    res.status(500).send({
      error: "Failed to load studios",
    });
  }
});

// Get featured studios
app.get("/studios/featured", async (req, res) => {
  try {
    const studios = await studiosCollection
      .find({
        status: "published",
        isFeatured: true,
      })
      .sort({ createdAt: -1 })
      .limit(8)
      .toArray();

    res.send(studios);
  } catch (error) {
    console.error("Failed to get featured studios:", error);
    res.status(500).send({
      error: "Failed to load featured studios",
    });
  }
});

// Get current host's studios
app.get("/studios/mine", verifyUserId, async (req, res) => {
  try {
    const studios = await studiosCollection
      .find({ ownerId: req.userId })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(studios);
  } catch (error) {
    console.error("Failed to get host studios:", error);
    res.status(500).send({
      error: "Failed to load your studios",
    });
  }
});

// Get a single studio
app.get("/studios/:id", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).send({
        error: "Invalid studio ID",
      });
    }

    const studio = await studiosCollection.findOne({
      _id: objectId(id),
      status: "published",
    });

    if (!studio) {
      return res.status(404).send({
        error: "Studio not found",
      });
    }

    res.send(studio);
  } catch (error) {
    console.error("Failed to get studio:", error);
    res.status(500).send({
      error: "Failed to load studio",
    });
  }
});

// Create a studio
app.post("/studios", verifyUserId, async (req, res) => {
  try {
    const {
      name,
      category,
      shortDescription,
      description,
      location,
      pricing,
      capacity,
      amenities,
      photos,
      availability,
      rules,
      status,
    } = req.body;

    if (
      typeof name !== "string" ||
      !name.trim() ||
      !category ||
      !location ||
      !pricing
    ) {
      return res.status(400).send({
        error: "Name, category, location and pricing are required",
      });
    }

    const now = new Date();

    const studio = {
      ownerId: req.userId,
      name: name.trim(),
      slug: `${name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`,
      category,
      shortDescription: shortDescription || "",
      description: description || "",
      location,
      pricing,
      capacity: capacity || {},
      amenities: amenities || [],
      photos: photos || [],
      availability: availability || {
        weeklySchedule: [],
        unavailableDates: [],
      },
      rules: rules || {},
      rating: {
        average: 0,
        totalReviews: 0,
      },
      status: status === "draft" ? "draft" : "published",
      isFeatured: false,
      createdAt: now,
      updatedAt: now,
    };

    const result = await studiosCollection.insertOne(studio);

    res.status(201).send({
      success: true,
      message: "Studio created successfully",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Failed to create studio:", error);
    res.status(500).send({
      error: "Failed to create studio",
    });
  }
});

// Update a studio
app.patch("/studios/:id", verifyUserId, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).send({
        error: "Invalid studio ID",
      });
    }

    const allowedFields = [
      "name",
      "category",
      "shortDescription",
      "description",
      "location",
      "pricing",
      "capacity",
      "amenities",
      "photos",
      "availability",
      "rules",
      "status",
    ];

    const updateData = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    }

    if (!Object.keys(updateData).length) {
      return res.status(400).send({
        error: "No valid fields provided",
      });
    }

    updateData.updatedAt = new Date();

    const result = await studiosCollection.updateOne(
      {
        _id: objectId(id),
        ownerId: req.userId,
      },
      { $set: updateData }
    );

    if (!result.matchedCount) {
      return res.status(404).send({
        error: "Studio not found or access denied",
      });
    }

    res.send({
      success: true,
      message: "Studio updated successfully",
    });
  } catch (error) {
    console.error("Failed to update studio:", error);
    res.status(500).send({
      error: "Failed to update studio",
    });
  }
});

// Delete a studio
app.delete("/studios/:id", verifyUserId, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).send({
        error: "Invalid studio ID",
      });
    }

    const result = await studiosCollection.deleteOne({
      _id: objectId(id),
      ownerId: req.userId,
    });

    if (!result.deletedCount) {
      return res.status(404).send({
        error: "Studio not found or access denied",
      });
    }

    res.send({
      success: true,
      message: "Studio deleted successfully",
    });
  } catch (error) {
    console.error("Failed to delete studio:", error);
    res.status(500).send({
      error: "Failed to delete studio",
    });
  }
});

// --------------------------------------------------
// 8. BOOKING ROUTES
// --------------------------------------------------

// Get current user's bookings as renter
app.get("/bookings/my", verifyUserId, async (req, res) => {
  try {
    const bookings = await bookingsCollection
      .find({ renterId: req.userId })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(bookings);
  } catch (error) {
    console.error("Failed to get renter bookings:", error);
    res.status(500).send({
      error: "Failed to load bookings",
    });
  }
});

// Get bookings for current host
app.get("/bookings/host", verifyUserId, async (req, res) => {
  try {
    const bookings = await bookingsCollection
      .find({ hostId: req.userId })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(bookings);
  } catch (error) {
    console.error("Failed to get host bookings:", error);
    res.status(500).send({
      error: "Failed to load booking requests",
    });
  }
});

// Get a single booking
app.get("/bookings/:id", verifyUserId, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).send({
        error: "Invalid booking ID",
      });
    }

    const booking = await bookingsCollection.findOne({
      _id: objectId(id),
      $or: [
        { renterId: req.userId },
        { hostId: req.userId },
      ],
    });

    if (!booking) {
      return res.status(404).send({
        error: "Booking not found",
      });
    }

    res.send(booking);
  } catch (error) {
    console.error("Failed to get booking:", error);
    res.status(500).send({
      error: "Failed to load booking",
    });
  }
});

// Create booking request
app.post("/bookings", verifyUserId, async (req, res) => {
  try {
    const {
      studioId,
      bookingDate,
      time,
      guests,
      requestMessage,
    } = req.body;

    if (
      !isValidObjectId(studioId) ||
      !bookingDate ||
      !time?.start ||
      !time?.end ||
      time.end <= time.start
    ) {
      return res.status(400).send({
        error: "Invalid booking information",
      });
    }

    const studio = await studiosCollection.findOne({
      _id: objectId(studioId),
      status: "published",
    });

    if (!studio) {
      return res.status(404).send({
        error: "Studio not found",
      });
    }

    if (studio.ownerId === req.userId) {
      return res.status(400).send({
        error: "You cannot book your own studio",
      });
    }

    const requestedDate = new Date(bookingDate);

    if (Number.isNaN(requestedDate.getTime())) {
      return res.status(400).send({
        error: "Invalid booking date",
      });
    }

    const overlap = await bookingsCollection.findOne({
      studioId,
      bookingDate: requestedDate,
      status: "confirmed",
      "time.start": { $lt: time.end },
      "time.end": { $gt: time.start },
    });

    if (overlap) {
      return res.status(409).send({
        error: "This time slot is already booked",
      });
    }

    const startMinutes =
      Number(time.start.split(":")[0]) * 60 +
      Number(time.start.split(":")[1]);

    const endMinutes =
      Number(time.end.split(":")[0]) * 60 +
      Number(time.end.split(":")[1]);

    const durationHours = (endMinutes - startMinutes) / 60;

    const hourlyRate = Number(studio.pricing.hourlyRate);
    const cleaningFee = Number(studio.pricing.cleaningFee || 0);
    const securityDeposit = Number(
      studio.pricing.securityDeposit || 0
    );

    if (
      !Number.isFinite(hourlyRate) ||
      hourlyRate < 0 ||
      !Number.isFinite(durationHours) ||
      durationHours <= 0
    ) {
      return res.status(400).send({
        error: "Invalid pricing or booking duration",
      });
    }

    const subtotal = hourlyRate * durationHours;
    const serviceFeeRate = 0;
    const serviceFee = subtotal * serviceFeeRate;
    const total =
      subtotal + cleaningFee + securityDeposit + serviceFee;

    const now = new Date();

    const booking = {
      studioId,
      hostId: studio.ownerId,
      renterId: req.userId,
      bookingDate: requestedDate,
      time: {
        start: time.start,
        end: time.end,
        durationHours,
      },
      guests: Number(guests || 1),
      pricing: {
        hourlyRate,
        hours: durationHours,
        subtotal,
        cleaningFee,
        securityDeposit,
        serviceFeeRate,
        serviceFee,
        total,
        currency: studio.pricing.currency || "BDT",
      },
      status: "pending",
      requestMessage: requestMessage || "",
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
    };

    const result = await bookingsCollection.insertOne(booking);

    await createNotification({
      userId: studio.ownerId,
      type: "booking_requested",
      title: "New Booking Request",
      message: "You have received a new studio booking request.",
      relatedData: {
        bookingId: result.insertedId.toString(),
        studioId,
      },
    });

    res.status(201).send({
      success: true,
      message: "Booking request submitted",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Failed to create booking:", error);
    res.status(500).send({
      error: "Failed to create booking",
    });
  }
});

// Confirm booking - only the host can confirm
app.patch("/bookings/:id/confirm", verifyUserId, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).send({
        error: "Invalid booking ID",
      });
    }

    const booking = await bookingsCollection.findOne({
      _id: objectId(id),
      hostId: req.userId,
      status: "pending",
    });

    if (!booking) {
      return res.status(404).send({
        error: "Pending booking not found",
      });
    }

    // Recheck availability before confirming
    const overlap = await bookingsCollection.findOne({
      _id: { $ne: booking._id },
      studioId: booking.studioId,
      bookingDate: booking.bookingDate,
      status: "confirmed",
      "time.start": { $lt: booking.time.end },
      "time.end": { $gt: booking.time.start },
    });

    if (overlap) {
      return res.status(409).send({
        error: "This booking slot is no longer available",
      });
    }

    const now = new Date();

    const result = await bookingsCollection.updateOne(
      {
        _id: booking._id,
        hostId: req.userId,
        status: "pending",
      },
      {
        $set: {
          status: "confirmed",
          confirmedAt: now,
          updatedAt: now,
        },
      }
    );

    if (!result.modifiedCount) {
      return res.status(409).send({
        error: "Booking status has changed",
      });
    }

    await createNotification({
      userId: booking.renterId,
      type: "booking_confirmed",
      title: "Booking Confirmed",
      message: "Your studio booking has been confirmed.",
      relatedData: {
        bookingId: id,
        studioId: booking.studioId,
      },
    });

    res.send({
      success: true,
      message: "Booking confirmed",
    });
  } catch (error) {
    console.error("Failed to confirm booking:", error);
    res.status(500).send({
      error: "Failed to confirm booking",
    });
  }
});

// Reject booking - only the host can reject
app.patch("/bookings/:id/reject", verifyUserId, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).send({
        error: "Invalid booking ID",
      });
    }

    const booking = await bookingsCollection.findOne({
      _id: objectId(id),
      hostId: req.userId,
      status: "pending",
    });

    if (!booking) {
      return res.status(404).send({
        error: "Pending booking not found",
      });
    }

    await bookingsCollection.updateOne(
      {
        _id: booking._id,
        hostId: req.userId,
        status: "pending",
      },
      {
        $set: {
          status: "rejected",
          updatedAt: new Date(),
        },
      }
    );

    await createNotification({
      userId: booking.renterId,
      type: "booking_rejected",
      title: "Booking Rejected",
      message: "Your studio booking request was rejected.",
      relatedData: {
        bookingId: id,
        studioId: booking.studioId,
      },
    });

    res.send({
      success: true,
      message: "Booking rejected",
    });
  } catch (error) {
    console.error("Failed to reject booking:", error);
    res.status(500).send({
      error: "Failed to reject booking",
    });
  }
});

// Cancel booking - renter or host
app.patch("/bookings/:id/cancel", verifyUserId, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).send({
        error: "Invalid booking ID",
      });
    }

    const booking = await bookingsCollection.findOne({
      _id: objectId(id),
      $or: [
        { renterId: req.userId },
        { hostId: req.userId },
      ],
      status: { $in: ["pending", "confirmed"] },
    });

    if (!booking) {
      return res.status(404).send({
        error: "Booking not found or cannot be cancelled",
      });
    }

    const now = new Date();

    await bookingsCollection.updateOne(
      { _id: booking._id },
      {
        $set: {
          status: "cancelled",
          cancellation: {
            cancelledBy: req.userId,
            reason: req.body?.reason || "",
            cancelledAt: now,
          },
          updatedAt: now,
        },
      }
    );

    const recipient =
      booking.renterId === req.userId
        ? booking.hostId
        : booking.renterId;

    await createNotification({
      userId: recipient,
      type: "booking_cancelled",
      title: "Booking Cancelled",
      message: "A booking has been cancelled.",
      relatedData: {
        bookingId: id,
        studioId: booking.studioId,
      },
    });

    res.send({
      success: true,
      message: "Booking cancelled",
    });
  } catch (error) {
    console.error("Failed to cancel booking:", error);
    res.status(500).send({
      error: "Failed to cancel booking",
    });
  }
});

// Mark booking as completed - host only
app.patch("/bookings/:id/complete", verifyUserId, async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).send({
        error: "Invalid booking ID",
      });
    }

    const result = await bookingsCollection.updateOne(
      {
        _id: objectId(id),
        hostId: req.userId,
        status: "confirmed",
      },
      {
        $set: {
          status: "completed",
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      }
    );

    if (!result.modifiedCount) {
      return res.status(404).send({
        error: "Confirmed booking not found",
      });
    }

    res.send({
      success: true,
      message: "Booking completed",
    });
  } catch (error) {
    console.error("Failed to complete booking:", error);
    res.status(500).send({
      error: "Failed to complete booking",
    });
  }
});

// --------------------------------------------------
// 9. REVIEW ROUTES
// --------------------------------------------------

// Get reviews for a studio
app.get("/studios/:id/reviews", async (req, res) => {
  try {
    const { id } = req.params;

    if (!isValidObjectId(id)) {
      return res.status(400).send({
        error: "Invalid studio ID",
      });
    }

    const reviews = await reviewsCollection
      .find({
        studioId: id,
        status: "published",
      })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(reviews);
  } catch (error) {
    console.error("Failed to get reviews:", error);
    res.status(500).send({
      error: "Failed to load reviews",
    });
  }
});

// Create review - only after completed booking
app.post("/studios/:id/reviews", verifyUserId, async (req, res) => {
  try {
    const { id } = req.params;
    const { bookingId, rating, comment } = req.body;

    if (
      !isValidObjectId(id) ||
      !isValidObjectId(bookingId) ||
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5 ||
      typeof comment !== "string" ||
      !comment.trim()
    ) {
      return res.status(400).send({
        error: "Invalid review information",
      });
    }

    const booking = await bookingsCollection.findOne({
      _id: objectId(bookingId),
      studioId: id,
      renterId: req.userId,
      status: "completed",
    });

    if (!booking) {
      return res.status(403).send({
        error: "A completed booking is required to review",
      });
    }

    const now = new Date();

    const review = {
      studioId: id,
      reviewerId: req.userId,
      bookingId,
      rating,
      comment: comment.trim(),
      status: "published",
      createdAt: now,
      updatedAt: now,
    };

    await reviewsCollection.insertOne(review);

    const [stats] = await reviewsCollection
      .aggregate([
        {
          $match: {
            studioId: id,
            status: "published",
          },
        },
        {
          $group: {
            _id: null,
            average: { $avg: "$rating" },
            totalReviews: { $sum: 1 },
          },
        },
      ])
      .toArray();

    await studiosCollection.updateOne(
      { _id: objectId(id) },
      {
        $set: {
          rating: {
            average: Number(stats.average.toFixed(1)),
            totalReviews: stats.totalReviews,
          },
          updatedAt: now,
        },
      }
    );

    await createNotification({
      userId: booking.hostId,
      type: "new_review",
      title: "New Studio Review",
      message: "Your studio received a new review.",
      relatedData: {
        studioId: id,
        bookingId,
      },
    });

    res.status(201).send({
      success: true,
      message: "Review submitted successfully",
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).send({
        error: "You have already reviewed this booking",
      });
    }

    console.error("Failed to create review:", error);
    res.status(500).send({
      error: "Failed to create review",
    });
  }
});

// --------------------------------------------------
// 10. WISHLIST ROUTES
// --------------------------------------------------

// Get current user's wishlist
app.get("/wishlist", verifyUserId, async (req, res) => {
  try {
    const wishlist = await wishlistsCollection
      .find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .toArray();

    const studioIds = wishlist
      .map((item) => item.studioId)
      .filter(isValidObjectId)
      .map(objectId);

    const studios = await studiosCollection
      .find({
        _id: { $in: studioIds },
        status: "published",
      })
      .toArray();

    res.send(studios);
  } catch (error) {
    console.error("Failed to get wishlist:", error);
    res.status(500).send({
      error: "Failed to load wishlist",
    });
  }
});

// Add studio to wishlist
app.post("/wishlist/:studioId", verifyUserId, async (req, res) => {
  try {
    const { studioId } = req.params;

    if (!isValidObjectId(studioId)) {
      return res.status(400).send({
        error: "Invalid studio ID",
      });
    }

    const studio = await studiosCollection.findOne({
      _id: objectId(studioId),
      status: "published",
    });

    if (!studio) {
      return res.status(404).send({
        error: "Studio not found",
      });
    }

    await wishlistsCollection.updateOne(
      {
        userId: req.userId,
        studioId,
      },
      {
        $setOnInsert: {
          userId: req.userId,
          studioId,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    res.send({
      success: true,
      message: "Studio added to wishlist",
    });
  } catch (error) {
    console.error("Failed to add wishlist:", error);
    res.status(500).send({
      error: "Failed to add studio to wishlist",
    });
  }
});

// Remove studio from wishlist
app.delete("/wishlist/:studioId", verifyUserId, async (req, res) => {
  try {
    const { studioId } = req.params;

    const result = await wishlistsCollection.deleteOne({
      userId: req.userId,
      studioId,
    });

    if (!result.deletedCount) {
      return res.status(404).send({
        error: "Wishlist item not found",
      });
    }

    res.send({
      success: true,
      message: "Studio removed from wishlist",
    });
  } catch (error) {
    console.error("Failed to remove wishlist:", error);
    res.status(500).send({
      error: "Failed to remove studio from wishlist",
    });
  }
});

// --------------------------------------------------
// 11. NOTIFICATION ROUTES
// --------------------------------------------------

// Get current user's notifications
app.get("/notifications", verifyUserId, async (req, res) => {
  try {
    const notifications = await notificationsCollection
      .find({ userId: req.userId })
      .sort({ createdAt: -1 })
      .toArray();

    res.send(notifications);
  } catch (error) {
    console.error("Failed to get notifications:", error);
    res.status(500).send({
      error: "Failed to load notifications",
    });
  }
});

// Mark one notification as read
app.patch(
  "/notifications/:id/read",
  verifyUserId,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return res.status(400).send({
          error: "Invalid notification ID",
        });
      }

      const result = await notificationsCollection.updateOne(
        {
          _id: objectId(id),
          userId: req.userId,
        },
        {
          $set: {
            isRead: true,
            updatedAt: new Date(),
          },
        }
      );

      if (!result.matchedCount) {
        return res.status(404).send({
          error: "Notification not found",
        });
      }

      res.send({
        success: true,
        message: "Notification marked as read",
      });
    } catch (error) {
      console.error("Failed to update notification:", error);
      res.status(500).send({
        error: "Failed to update notification",
      });
    }
  }
);

// Mark all notifications as read
app.patch("/notifications/read-all", verifyUserId, async (req, res) => {
  try {
    await notificationsCollection.updateMany(
      {
        userId: req.userId,
        isRead: false,
      },
      {
        $set: {
          isRead: true,
          updatedAt: new Date(),
        },
      }
    );

    res.send({
      success: true,
      message: "All notifications marked as read",
    });
  } catch (error) {
    console.error("Failed to update notifications:", error);
    res.status(500).send({
      error: "Failed to update notifications",
    });
  }
});

// Delete notification
app.delete(
  "/notifications/:id",
  verifyUserId,
  async (req, res) => {
    try {
      const { id } = req.params;

      if (!isValidObjectId(id)) {
        return res.status(400).send({
          error: "Invalid notification ID",
        });
      }

      const result = await notificationsCollection.deleteOne({
        _id: objectId(id),
        userId: req.userId,
      });

      if (!result.deletedCount) {
        return res.status(404).send({
          error: "Notification not found",
        });
      }

      res.send({
        success: true,
        message: "Notification deleted",
      });
    } catch (error) {
      console.error("Failed to delete notification:", error);
      res.status(500).send({
        error: "Failed to delete notification",
      });
    }
  }
);

// --------------------------------------------------
// 12. CONTACT MESSAGE ROUTES
// --------------------------------------------------

// Public contact form submission
app.post("/contact", async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;

    if (
      typeof name !== "string" ||
      !name.trim() ||
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
      typeof message !== "string" ||
      !message.trim()
    ) {
      return res.status(400).send({
        error: "Valid name, email and message are required",
      });
    }

    const result = await contactMessagesCollection.insertOne({
      name: name.trim(),
      email: email.trim().toLowerCase(),
      subject: typeof subject === "string" ? subject.trim() : "",
      message: message.trim(),
      status: "new",
      createdAt: new Date(),
    });

    res.status(201).send({
      success: true,
      message: "Your message has been submitted",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Contact submission failed:", error);
    res.status(500).send({
      error: "Failed to submit contact message",
    });
  }
});

// --------------------------------------------------
// 13. NEWSLETTER ROUTES
// --------------------------------------------------

// Subscribe to newsletter
app.post("/newsletter/subscribe", async (req, res) => {
  try {
    const { email } = req.body;

    if (
      typeof email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    ) {
      return res.status(400).send({
        error: "A valid email is required",
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    await newsletterSubscribersCollection.updateOne(
      { email: normalizedEmail },
      {
        $set: {
          isSubscribed: true,
          updatedAt: new Date(),
        },
        $setOnInsert: {
          email: normalizedEmail,
          createdAt: new Date(),
        },
      },
      { upsert: true }
    );

    res.send({
      success: true,
      message: "Successfully subscribed",
    });
  } catch (error) {
    console.error("Newsletter subscription failed:", error);
    res.status(500).send({
      error: "Failed to subscribe",
    });
  }
});

// Unsubscribe from newsletter
app.patch("/newsletter/unsubscribe", async (req, res) => {
  try {
    const { email } = req.body;

    if (typeof email !== "string" || !email.trim()) {
      return res.status(400).send({
        error: "Email is required",
      });
    }

    const result = await newsletterSubscribersCollection.updateOne(
      { email: email.trim().toLowerCase() },
      {
        $set: {
          isSubscribed: false,
          updatedAt: new Date(),
        },
      }
    );

    if (!result.matchedCount) {
      return res.status(404).send({
        error: "Subscriber not found",
      });
    }

    res.send({
      success: true,
      message: "Unsubscribed successfully",
    });
  } catch (error) {
    console.error("Newsletter unsubscribe failed:", error);
    res.status(500).send({
      error: "Failed to unsubscribe",
    });
  }
});

// --------------------------------------------------
// 14. SERVER
// --------------------------------------------------

app.listen(port, () => {
  console.log(`SetSpace API listening on port ${port}`);
});

export default app;
