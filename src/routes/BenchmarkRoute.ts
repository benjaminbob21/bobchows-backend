import express, { Request, Response } from "express";
import { emitGroupOrderUpdate } from "../socket";
import GroupOrder from "../models/groupOrder";

// Development-only benchmark endpoint used by the Study B harness
// (research/benchmark/study-b.mjs). It simulates a state change (a
// participant paying or a restaurant advancing the order) and measures the
// transport latency of pushing that change to connected clients. Never
// exposed when NODE_ENV=production.
const router = express.Router();

router.post("/emit", async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ message: "Not found" });
  }

  const { groupOrderId } = req.body;
  if (!groupOrderId) {
    return res.status(400).json({ message: "groupOrderId required" });
  }

  // Push a fresh snapshot to the room — simulates a state change without a
  // real Stripe payment. The emit payload includes serverTime so clients can
  // compute one-way transport latency.
  await emitGroupOrderUpdate(groupOrderId);
  res.json({ ok: true, groupOrderId });
});

// Unauthenticated state read for the polling benchmark arm (dev only).
router.get("/state", async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production") {
    return res.status(404).json({ message: "Not found" });
  }
  const { groupOrderId } = req.query;
  if (!groupOrderId) {
    return res.status(400).json({ message: "groupOrderId required" });
  }
  const order = await GroupOrder.findById(groupOrderId).lean();
  if (!order) {
    return res.status(404).json({ message: "Group order not found" });
  }
  res.json({
    groupOrderId: order._id.toString(),
    status: order.status,
    paidCount: order.paidParticipants.length,
    totalParticipants: order.totalParticipants,
    serverTime: Date.now(),
  });
});

export default router;
