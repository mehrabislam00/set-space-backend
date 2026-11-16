import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Environment variables
const username = process.env.MONGODB_USERNAME;
const password = process.env.MONGODB_PASSWORD;

// Check if username and password are provided
if (!username || !password) {
  throw new Error("MONGODB_USERNAME and MONGODB_PASSWORD must be configured");
}

const client = new MongoClient(
  `mongodb://${encodeURIComponent(username)}:${encodeURIComponent(password)}@ac-tikzacb-shard-00-00.rbwczib.mongodb.net:27017,ac-tikzacb-shard-00-01.rbwczib.mongodb.net:27017,ac-tikzacb-shard-00-02.rbwczib.mongodb.net:27017/?ssl=true&replicaSet=atlas-11uhlz-shard-0&authSource=admin`,
);



// Function to connect to MongoDB
export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("Failed to connect to MongoDB:", err);
    throw err;
  }
}

// Connect to MongoDB and get the destinations collection
const ConnectedClient = await connectToMongoDB();
const db = ConnectedClient.db("set-space-db");
const authDb = ConnectedClient.db("auth");
const authUsersCollection = authDb.collection("user");
const authUserSessionsCollection = authDb.collection("session");
const authAccountsCollection = authDb.collection("account");
const authUserVerificationsCollection = authDb.collection("verification");
const userProfilesCollection = db.collection("userProfiles");
const studiosCollection = db.collection("studios");
const bookingsCollection = db.collection("bookings");
const reviewsCollection = db.collection("reviews");
const wishlistsCollection = db.collection("wishlists");
const notificationsCollection = db.collection("notifications");












// Example route
app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});