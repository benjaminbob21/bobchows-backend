import express from "express";
import { jwtCheck, jwtParse } from "../middleware/auth";
import OrderController from "../controllers/OrderController";

const router = express.Router();

router.get("/", jwtCheck, jwtParse, OrderController.getMyOrders);

router.post(
  "/checkout/create-checkout-session",
  jwtCheck,
  jwtParse,
  OrderController.createCheckoutSession
);

router.post("/checkout/webhook", OrderController.stripeWebhookHandler);

router.post("/group", jwtCheck, jwtParse, OrderController.createGroupOrder);

router.post("/get-link", jwtCheck, jwtParse, OrderController.getLinkAndOrder);

router.get("/get-group", jwtCheck, jwtParse, OrderController.getGroupOrder);

router.post(
  "/join-group/:groupOrderId",
  jwtCheck,
  jwtParse,
  OrderController.joinGroupOrder
);

router.post(
  "/confirm-group-payment",
  jwtCheck,
  jwtParse,
  OrderController.confirmGroupPayment
);

export default router;
