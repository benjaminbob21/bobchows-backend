import mongoose from "mongoose";

const groupOrderSchema = new mongoose.Schema({
  restaurant: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Restaurant",
    required: true,
  },
  restaurantName: { type: String },
  initiator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },
  initiatorName: { type: String },
  paidParticipants: [
    {
      user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      email: { type: String, required: true },
      amount: { type: Number, required: true },
      paidAt: { type: Date, default: Date.now },
    },
  ],
  totalParticipants: { type: Number, required: true },
  deliveryDetails: {
    email: { type: String },
    name: { type: String },
    addressLine1: { type: String },
    city: { type: String },
  },
  cartItems: [
    {
      menuItemId: { type: String, required: true },
      quantity: { type: Number, required: true },
      name: { type: String, required: true },
    },
  ],
  totalAmount: { type: Number, required: true },
  amountPerPerson: { type: Number, required: true },
  status: {
    type: String,
    enum: [
      "created",
      "inProgress",
      "paid",
      "placed",
      "outForDelivery",
      "delivered",
      "cancelled",
    ],
    default: "created",
  },
  expiresAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

groupOrderSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

const GroupOrder = mongoose.model("GroupOrder", groupOrderSchema);
export default GroupOrder;
