import mongoose, { InferSchemaType } from "mongoose";

const menuItemSchema = new mongoose.Schema({
  _id: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    default: () => new mongoose.Types.ObjectId(),
  },
  name: { type: String, required: true },
  price: { type: Number, required: true },
});

export type MenuItemType = InferSchemaType<typeof menuItemSchema>;

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
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  },
  { timestamps: true }
);

export type ReviewType = InferSchemaType<typeof reviewSchema>;

const restaurantSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  restaurantName: { type: String, required: true },
  city: { type: String, required: true },
  country: { type: String, required: true },
  deliveryPrice: { type: Number, required: true },
  estimatedDeliveryTime: { type: Number, required: true },
  cuisines: [{ type: String, required: true }],
  menuItems: [menuItemSchema],
  imageUrl: { type: String, required: true },
  lastUpdated: { type: Date, required: true },
  reviews:[reviewSchema],
  totalRating: { type: Number, default: 0 },
  reviewCount: { type: Number, default: 0 },
  averageRating: { type: Number, default: 0 },
});

const Restaurant = mongoose.model("Restaurant", restaurantSchema);
export default Restaurant;
