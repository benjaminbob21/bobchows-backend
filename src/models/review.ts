import mongoose from "mongoose";

const reviewSchema = new mongoose.Schema(
  {
    restaurant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Restaurant",
      required: true,
    },
    rating: { type: Number, required: true, min: 1, max: 5 },
    name: { type: String, required: true },
    comment: { type: String, required: true },
    country: { type: String, required: true },
    city: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

const Review = mongoose.model("Review", reviewSchema);
export default Review;
