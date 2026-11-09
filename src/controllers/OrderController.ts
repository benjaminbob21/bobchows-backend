import Stripe from "stripe";
import { Request, Response } from "express";
import Restaurant, { MenuItemType } from "../models/restaurant";
import Order from "../models/order";
import GroupOrder from "../models/groupOrder";
import User from "../models/user";
import { emitGroupOrderUpdate, isWebSocketEnabled } from "../socket";

const STRIPE = new Stripe(process.env.STRIPE_API_KEY as string);
const FRONTEND_URL = process.env.FRONTEND_URL as string;
const STRIPE_ENDPOINT_SECRET = process.env.STRIPE_WEBHOOK_SECRET as string;

const getMyOrders = async (req: Request, res: Response) => {
  try {
    const orders = await Order.find({ user: req.userId })
      .populate("restaurant")
      .populate("user");

    res.json(orders);
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "something went wrong" });
  }
};

type CheckoutSessionRequest = {
  cartItems: {
    menuItemId: string;
    name: string;
    quantity: string;
  }[];
  deliveryDetails: {
    email: string;
    name: string;
    addressLine1: string;
    city: string;
  };
  restaurantId: string;
  groupOrderId?: string;
};

const handleIndividualOrderPayment = async (orderId: string, session: any) => {
  const order = await Order.findById(orderId);
  if (!order) {
    console.error(`Order not found.`);
    return;
  }

  order.totalAmount = session.amount_total;
  order.status = "paid";
  await order.save();
};

const handleGroupOrderPayment = async (
  groupOrderId: string,
  userId: string,
  name: string,
  session: any
) => {
  const groupOrder = await GroupOrder.findById(groupOrderId);
  if (!groupOrder) {
    console.error(`Group order not found: ${groupOrderId}`);
    return;
  }

  const user = await User.findById(userId);
  if (!user) {
    console.error(`User not found: ${userId}`);
    return;
  }

  // Dedupe: never add the same user twice, even if the webhook fires
  // alongside the client-side confirm fallback.
  if (
    groupOrder.paidParticipants.some(
      (p) => p.user && p.user.toString() === user._id.toString()
    )
  ) {
    console.log(`User ${userId} already in paidParticipants, skipping`);
    return;
  }

  if (groupOrder.deliveryDetails) {
    if (groupOrder.deliveryDetails.name != "") {
      groupOrder.deliveryDetails.name += `, ${name}`;
    } else {
      groupOrder.deliveryDetails.name = name;
    }
  }

  groupOrder.paidParticipants.push({
    email: session.customer_details.email,
    amount: session.amount_total,
    user: user._id,
  });

  if (groupOrder.paidParticipants.length === groupOrder.totalParticipants) {
    groupOrder.status = "paid";
    // Create the actual order here
    const newOrder = new Order({
      restaurant: groupOrder.restaurant,
      user: groupOrder.initiator,
      groupOrderId: groupOrder._id,
      status: "paid",
      deliveryDetails: groupOrder.deliveryDetails,
      cartItems: groupOrder.cartItems,
      createdAt: new Date(),
      totalAmount: groupOrder.totalAmount,
    });
    await newOrder.save();
  }

  await groupOrder.save();

  // Real-time: push the updated state to every client watching this group order
  if (isWebSocketEnabled()) {
    await emitGroupOrderUpdate(groupOrderId);
  }
};

const stripeWebhookHandler = async (req: Request, res: Response) => {
  let event;

  try {
    const sig = req.headers["stripe-signature"];
    event = STRIPE.webhooks.constructEvent(
      req.body,
      sig as string,
      STRIPE_ENDPOINT_SECRET
    );
  } catch (error: any) {
    console.log(error);
    return res.status(400).send(`Webhook error: ${error.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    if (session.metadata) {
      const { groupOrderId, orderId, userId, name } = session.metadata;
      if (groupOrderId) {
        await handleGroupOrderPayment(groupOrderId, userId, name, session);
      } else if (orderId) {
        await handleIndividualOrderPayment(orderId, session);
      }
    }

    res.status(200).send();
  }
};

const createCheckoutSession = async (req: Request, res: Response) => {
  try {
    const checkoutSessionRequest: CheckoutSessionRequest = req.body;

    const restaurant = await Restaurant.findById(
      checkoutSessionRequest.restaurantId
    );

    if (!restaurant) {
      throw new Error("Restaurant not found");
    }

    if (checkoutSessionRequest.groupOrderId) {
      await handleGroupCheckout(checkoutSessionRequest, req, res, restaurant);
    } else {
      await handleIndividualCheckout(
        checkoutSessionRequest,
        req,
        res,
        restaurant
      );
    }
  } catch (error: any) {
    console.log(error);
    res.status(500).json({ message: error.raw?.message || error.message || "Unable to create checkout session" });
  }
};

const handleGroupCheckout = async (
  checkoutSessionRequest: CheckoutSessionRequest,
  req: Request,
  res: Response,
  restaurant: any
) => {
  const groupOrder = await GroupOrder.findById(
    checkoutSessionRequest.groupOrderId
  );

  if (!groupOrder) {
    return res.status(404).json({ message: "Group order not found" });
  }

  groupOrder.deliveryDetails = checkoutSessionRequest.deliveryDetails;
  groupOrder.deliveryDetails.name = "";
  groupOrder.initiatorName = checkoutSessionRequest.deliveryDetails.name;
  groupOrder.restaurantName = restaurant.restaurantName;

  await groupOrder.save();

  if (
    groupOrder.paidParticipants.some(
      (p) => p.email === checkoutSessionRequest.deliveryDetails.email
    )
  ) {
    return res
      .status(400)
      .json({ message: "You have already paid your share" });
  }

  const session = await createSession(
    [
      {
        price_data: {
          currency: "usd",
          unit_amount: Math.round(groupOrder.amountPerPerson),
          product_data: {
            name: "Your share of the group order",
          },
        },
        quantity: 1,
      },
    ],
    groupOrder._id.toString(),
    0,
    restaurant._id.toString(),
    req.userId,
    checkoutSessionRequest.deliveryDetails.name,
    true,
    checkoutSessionRequest.groupOrderId
  );

  if (!session.url) {
    return res.status(500).json({ message: "Error creating stripe session" });
  }

  res.json({ url: session.url });
};

const handleIndividualCheckout = async (
  checkoutSessionRequest: CheckoutSessionRequest,
  req: Request,
  res: Response,
  restaurant: any
) => {
  const lineItems = createLineItems(
    checkoutSessionRequest,
    restaurant.menuItems
  );

  const totalAmount =
    lineItems.reduce(
      (total, item) =>
        total + (item.price_data?.unit_amount || 0) * (item.quantity || 1),
      0
    ) + Math.round(restaurant.deliveryPrice);

  const newOrder = new Order({
    restaurant: restaurant,
    user: req.userId,
    status: "placed",
    deliveryDetails: checkoutSessionRequest.deliveryDetails,
    cartItems: checkoutSessionRequest.cartItems,
    totalAmount: totalAmount,
    createdAt: new Date(),
  });

  const session = await createSession(
    lineItems,
    newOrder._id.toString(),
    restaurant.deliveryPrice,
    restaurant._id.toString(),
    req.userId,
    checkoutSessionRequest.deliveryDetails.name
  );

  if (!session.url) {
    return res.status(500).json({ message: "Error creating stripe session" });
  }

  await newOrder.save();
  res.json({ url: session.url });
};

const createLineItems = (
  checkoutSessionRequest: CheckoutSessionRequest,
  menuItems: MenuItemType[]
) => {
  const lineItems = checkoutSessionRequest.cartItems.map((cartItem) => {
    const menuItem = menuItems.find(
      (item) => item._id.toString() === cartItem.menuItemId.toString()
    );

    if (!menuItem) {
      throw new Error(`Menu item not found: ${cartItem.menuItemId}`);
    }

    const unitAmount = Math.round(menuItem.price);

    const line_item: Stripe.Checkout.SessionCreateParams.LineItem = {
      price_data: {
        currency: "usd",
        unit_amount: unitAmount,
        product_data: {
          name: menuItem.name,
        },
      },
      quantity: parseInt(cartItem.quantity),
    };

    return line_item;
  });

  return lineItems;
};

const createSession = async (
  lineItems: Stripe.Checkout.SessionCreateParams.LineItem[],
  orderId: string,
  deliveryPrice: number,
  restaurantId: string,
  userId: string,
  name: string,
  isGroupOrder: boolean = false,
  groupId: string | null = null
) => {
  const deliveryAmount = Math.round(deliveryPrice);

  const sessionData = await STRIPE.checkout.sessions.create({
    line_items: lineItems,
    shipping_options: isGroupOrder
      ? []
      : [
          {
            shipping_rate_data: {
              display_name: "Delivery",
              type: "fixed_amount",
              fixed_amount: {
                amount: deliveryAmount,
                currency: "usd",
              },
            },
          },
        ],
    mode: "payment",
    metadata: {
      orderId,
      restaurantId,
      userId,
      name,
      isGroupOrder: isGroupOrder.toString(),
      groupOrderId: groupId,
    },
    success_url: isGroupOrder
      ? `${FRONTEND_URL}/group-order-status?success=true&groupOrderId=${groupId}`
      : `${FRONTEND_URL}/order-status?success=true`,
    cancel_url: `${FRONTEND_URL}/detail/${restaurantId}?cancelled=true`,
  });

  return sessionData;
};

const createGroupOrder = async (req: Request, res: Response) => {
  try {
    const { cartItems, restaurantId } = req.body;

    const restaurant = await Restaurant.findById(restaurantId);

    if (!restaurant) {
      return res.status(404).json({ message: "Restaurant not found" });
    }

    let totalAmount = 0;
    cartItems.forEach((item: any) => {
      const menuItem = restaurant.menuItems.find(
        (menuItem: any) => menuItem._id.toString() === item.menuItemId
      );
      if (menuItem) {
        totalAmount += menuItem.price * parseInt(item.quantity);
      }
    });

    totalAmount += restaurant.deliveryPrice;

    const newGroupOrder = new GroupOrder({
      restaurant: restaurant._id,
      initiator: req.userId,
      status: "created",
      cartItems: cartItems,
      totalParticipants: 4,
      paidParticipants: [],
      totalAmount: totalAmount,
      amountPerPerson: (totalAmount / 4).toFixed(2),
      createdAt: new Date(),
    });

    await newGroupOrder.save();

    const shareableLink = `${FRONTEND_URL}/join-order/${newGroupOrder._id}`;

    res.status(201).json({
      groupOrder: newGroupOrder,
      shareableLink: shareableLink,
      id: newGroupOrder._id,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Something went wrong" });
  }
};

const getGroupOrder = async (req: Request, res: Response) => {
  try {
    const groupOrder = await GroupOrder.find({
      $or: [{ initiator: req.userId }, { "paidParticipants.user": req.userId }],
    })
      .populate("restaurant")
      .populate("paidParticipants.user");

    if (!groupOrder) {
      return res.status(404).json({ message: "Group order not found" });
    }

    res.json(groupOrder);
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Something went wrong" });
  }
};

const getLinkAndOrder = async (req: Request, res: Response) => {
  try {
    const { groupOrderId } = req.body;

    const groupOrder = await GroupOrder.findById(groupOrderId);

    if (!groupOrder) {
      return res.status(404).json({ message: "Group order not found" });
    }

    const shareableLink = `${FRONTEND_URL}/join-order/${groupOrder._id}`;

    res.status(201).json({
      groupOrder: groupOrder,
      shareableLink: shareableLink,
      id: groupOrder._id,
    });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Something went wrong" });
  }
};

const joinGroupOrder = async (req: Request, res: Response) => {
  try {
    const { deliveryDetails, groupOrderId } = req.body;

    const groupOrder = await GroupOrder.findById(groupOrderId);

    if (!groupOrder) {
      return res.status(404).json({ message: "Group order not found" });
    }

    if (
      groupOrder.paidParticipants.some(
        (p) => p.email === deliveryDetails.email
      )
    ) {
      return res
        .status(400)
        .json({ message: "You have already joined and paid" });
    } else if (groupOrder.status == "paid") {
      return res.status(400).json({ message: "Group Order is full" });
    }

    const session = await createSession(
      [
        {
          price_data: {
            currency: "usd",
            unit_amount: Math.round(groupOrder.amountPerPerson),
            product_data: {
              name: "Your share of the group order",
            },
          },
          quantity: 1,
        },
      ],
      groupOrder._id.toString(),
      0,
      groupOrder.restaurant.toString(),
      req.userId,
      deliveryDetails.name,
      true,
      groupOrderId
    );

    if (!session.url) {
      return res.status(500).json({ message: "Error creating Stripe session" });
    }

    res.json({ url: session.url });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Something went wrong" });
  }
};


const confirmGroupPayment = async (req: Request, res: Response) => {
  try {
    const { groupOrderId } = req.body;

    const groupOrder = await GroupOrder.findById(groupOrderId);
    if (!groupOrder) {
      return res.status(404).json({ message: "Group order not found" });
    }

    const user = await User.findById(req.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Atomic push: the $ne filter guarantees this user is only added once,
    // even if two confirm requests arrive concurrently (e.g. React StrictMode
    // double-firing the redirect effect in dev).
    const result = await GroupOrder.updateOne(
      {
        _id: groupOrder._id,
        "paidParticipants.user": { $ne: user._id },
      },
      {
        $push: {
          paidParticipants: {
            email: user.email,
            amount: groupOrder.amountPerPerson,
            user: user._id,
          },
        },
      }
    );

    if (result.matchedCount === 0) {
      return res
        .status(200)
        .json({ message: "Already confirmed", groupOrder });
    }

    // Re-read the fresh document (now includes the pushed participant)
    const updated = await GroupOrder.findById(groupOrderId);
    if (!updated) {
      return res.status(404).json({ message: "Group order not found" });
    }

    if (updated.deliveryDetails) {
      if (updated.deliveryDetails.name != "") {
        updated.deliveryDetails.name += `, ${user.name}`;
      } else {
        updated.deliveryDetails.name = user.name;
      }
    }

    if (updated.paidParticipants.length === updated.totalParticipants) {
      updated.status = "paid";
      const newOrder = new Order({
        restaurant: updated.restaurant,
        user: updated.initiator,
        groupOrderId: updated._id,
        status: "paid",
        deliveryDetails: updated.deliveryDetails,
        cartItems: updated.cartItems,
        createdAt: new Date(),
        totalAmount: updated.totalAmount,
      });
      await newOrder.save();
    }

    await updated.save();

    // Real-time: notify all participants that a member's payment landed
    if (isWebSocketEnabled()) {
      await emitGroupOrderUpdate(groupOrderId);
    }

    res.status(200).json({ message: "Payment confirmed", groupOrder: updated });
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Something went wrong" });
  }
};

export default {
  getMyOrders,
  createCheckoutSession,
  stripeWebhookHandler,
  createGroupOrder,
  getGroupOrder,
  joinGroupOrder,
  getLinkAndOrder,
  confirmGroupPayment,
};

