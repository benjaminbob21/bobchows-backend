// Test bootstrap: load environment, connect to the same MongoDB Atlas cluster
// the app uses (see .env), and fail fast if credentials are missing.
import "dotenv/config";
import mongoose from "mongoose";

export const MONGO_URL =
  process.env.MONGO_URI ||
  process.env.MONGO_ATLAS_URI ||
  process.env.MONGODB_CONNECTION_STRING ||
  "";

if (!MONGO_URL) {
  throw new Error(
    "MONGODB_CONNECTION_STRING / MONGO_URI / MONGO_ATLAS_URI not set. Copy .env into test environment.",
  );
}

beforeAll(async () => {
  await mongoose.connect(MONGO_URL, { dbName: "bobchows_test" });
});

afterAll(async () => {
  await mongoose.disconnect();
});
