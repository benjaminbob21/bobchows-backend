import { Server as HttpServer } from "http";
import { Server } from "socket.io";
import GroupOrder from "./models/groupOrder";

// Real-time sync layer (research protocol Study B). The Socket.IO server is
// attached to the same HTTP server as Express, and clients join a room per
// group order so they receive instant status/participant updates instead of
// waiting for the next 5s polling tick.
//
// Controlled by USE_WEBSOCKET (default "true"). When disabled the app falls
// back to HTTP polling only, which is the baseline condition in Study B.

let io: Server | null = null;

export const isWebSocketEnabled = () =>
  process.env.USE_WEBSOCKET !== "false";

export const initSocket = (server: HttpServer) => {
  io = new Server(server, {
    cors: {
      origin: process.env.FRONTEND_URL || "*",
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    socket.on("groupOrder:join", (groupOrderId: string) => {
      if (!groupOrderId) return;
      socket.join(`group:${groupOrderId}`);
    });

    socket.on("groupOrder:leave", (groupOrderId: string) => {
      if (!groupOrderId) return;
      socket.leave(`group:${groupOrderId}`);
    });
  });

  return io;
};

export const getIO = () => io;

/**
 * Broadcast an updated group order to everyone watching it. The payload is
 * the plain serialized document (without mongoose helpers), matching the
 * shape clients already render from the REST API.
 */
export const emitGroupOrderUpdate = async (groupOrderId: string) => {
  if (!io) return;

  try {
    const groupOrder = await GroupOrder.findById(groupOrderId)
      .populate("restaurant")
      .populate("paidParticipants.user");
    if (!groupOrder) return;

    io.to(`group:${groupOrderId}`).emit("groupOrder:update", {
      groupOrderId: groupOrder._id.toString(),
      status: groupOrder.status,
      paidCount: groupOrder.paidParticipants.length,
      totalParticipants: groupOrder.totalParticipants,
      deliveryDetails: groupOrder.deliveryDetails,
      restaurantName: groupOrder.restaurantName,
      amountPerPerson: groupOrder.amountPerPerson,
      totalAmount: groupOrder.totalAmount,
      initiatorName: groupOrder.initiatorName,
      serverTime: Date.now(),
      paidParticipants: groupOrder.paidParticipants.map((p) => ({
        name: (p.user as any)?.name,
        email: p.email,
        amount: p.amount,
        paidAt: p.paidAt,
      })),
    });
  } catch (error) {
    console.error("Failed to emit group order update:", error);
  }
};

export const SOCKET_EVENTS = {
  GROUP_ORDER_UPDATE: "groupOrder:update",
  JOIN_GROUP: "groupOrder:join",
  LEAVE_GROUP: "groupOrder:leave",
} as const;
