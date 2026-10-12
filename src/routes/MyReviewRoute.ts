import express from "express";
import { jwtCheck, jwtParse } from "../middleware/auth";
import { createReview, getReviewsByRestaurant } from "../controllers/MyReviewController";

const router = express.Router();

router.post("/", jwtCheck, jwtParse, createReview);
router.get("/restaurant/:restaurantId", getReviewsByRestaurant);

export default router;