import express, { Request, Response } from "express";
import cors from "cors";
import "dotenv/config";
import mongoose from "mongoose";
import { createServer } from "http";
import myUserRoute from "./routes/MyUserRoute";
import { v2 as cloudinary } from "cloudinary";
import myRestaurantRoute from "./routes/MyRestaurantRoute";
import restaurantRoute from "./routes/RestaurantRoute";
import orderRoute from "./routes/OrderRoute";
import reviewRoutes from "./routes/MyReviewRoute";
import benchmarkRoute from "./routes/BenchmarkRoute";
import { initSocket, isWebSocketEnabled } from "./socket";
mongoose
  .connect(process.env.MONGODB_CONNECTION_STRING as string)
  .then(() => console.log("Connected to database!"));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();

app.use(cors());

app.use("/api/order/checkout/webhook", express.raw({ type: "*/*" }));

app.use(express.json());

app.get("/health", async (req: Request, res: Response) => {
  res.send({ message: "health OK!" });
});

app.use("/api/my/user", myUserRoute);
app.use("/api/my/restaurant", myRestaurantRoute);
app.use("/api/restaurant", restaurantRoute);
app.use("/api/order", orderRoute);
app.use("/api/reviews", reviewRoutes);
app.use("/api/benchmark", benchmarkRoute);

const port = process.env.PORT || 7001;
const server = createServer(app);

if (isWebSocketEnabled()) {
  initSocket(server);
  console.log("Socket.IO real-time sync enabled (USE_WEBSOCKET=true)");
} else {
  console.log("Socket.IO disabled - falling back to HTTP polling");
}

server.listen(port, () => {
  console.log(`server started on localhost:${port}`);
});
