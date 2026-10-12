import { Request, Response } from "express";
import Restaurant from "../models/restaurant";
import Review from "../models/review";
import mongoose from "mongoose";
import User from "../models/user";


interface IReview {
  restaurant: mongoose.Types.ObjectId;
  name: string;
  rating: number;
  comment: string;
  country: string;
  city: string;
  user: mongoose.Types.ObjectId;
}


export const createReview = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { restaurantId, rating, comment } = req.body;
    const userId = req.userId;

    if (!userId) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    const restaurant = await Restaurant.findById(restaurantId);
    const currentUser = await User.findById(userId);

    if (!currentUser) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }

    if (!restaurant) {
      res.status(404).json({ message: "Restaurant not found" });
      return;
    }

    const alreadyReviewed = await Review.findOne({
      restaurant: restaurantId,
      user: userId,
    });

    if (alreadyReviewed) {
      res.status(400).json({ message: "Restaurant already reviewed" });
      return;
    }
    if (rating < 1 || rating > 5) {
      res.status(400).json({ message: "Rating must be between 1 and 5" });
      return;
    }

    const newReview: IReview = {
      restaurant: restaurant._id,
      name: currentUser.name || currentUser.email,
      country: restaurant.country,
      city: restaurant.city,
      rating,
      comment,
      user: currentUser._id,
    };

    const createdReview = await Review.create(newReview);

    const update = {
      $inc: { totalRating: rating, reviewCount: 1 },
      $set: { lastReviewedAt: new Date() },
    };

    const updatedRestaurant = await Restaurant.findByIdAndUpdate(
      restaurant._id,
      update,
      { new: true }
    );

    if (!updatedRestaurant) {
      res.status(404).json({ message: "Restaurant not found" });
      return;
    }
    const avgRating =
      updatedRestaurant.totalRating / updatedRestaurant.reviewCount;
    await Restaurant.findByIdAndUpdate(restaurantId, {
      averageRating: avgRating,
    });

    res
      .status(201)
      .json({ message: "Review created successfully", review: createdReview });
  } catch (error) {
    res
      .status(500)
      .json({
        message: "Error creating review",
        error: (error as Error).message,
      });
  }
};

export const getReviewsByRestaurant = async (
  req: Request,
  res: Response
): Promise<void> => {
  try {
    const { restaurantId } = req.params;
    const reviews = await Review.find({ restaurant: restaurantId }).populate(
      "user",
      "name"
    );
    if (!reviews) {
      res.status(404).json({ message: "No reviews found for this restaurant" });
      return;
    }
    res.status(200).json(reviews);
  } catch (error) {
    res
      .status(500)
      .json({
        message: "Error fetching reviews",
        error: (error as Error).message,
      });
  }
};
