import mongoose from "mongoose";
import OrderController from "../src/controllers/OrderController";
import Restaurant from "../src/models/restaurant";
import GroupOrder from "../src/models/groupOrder";
import Order from "../src/models/order";
import User from "../src/models/user";

// --- helpers ---------------------------------------------------------------

const mockRes = () => {
  const res: any = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.sendStatus = jest.fn().mockReturnValue(res);
  return res;
};

const makeUser = (auth0Id: string, email: string, name: string) =>
  new User({ auth0Id, email, name }).save();

const makeRestaurant = async () =>
  new Restaurant({
    restaurantName: `Test Kitchen ${Date.now()}`,
    city: "Nashville",
    country: "US",
    deliveryPrice: 500, // cents
    estimatedDeliveryTime: 30,
    cuisines: ["Test"],
    menuItems: [
      {
        name: "Bison Burger",
        price: 1200,
      },
    ],
    imageUrl: "https://example.com/img.png",
    lastUpdated: new Date(),
  }).save();

const makeGroupOrder = async (
  restaurantId: mongoose.Types.ObjectId,
  initiatorId: mongoose.Types.ObjectId,
  overrides: any = {},
) =>
  new GroupOrder({
    restaurant: restaurantId,
    initiator: initiatorId,
    status: "created",
    cartItems: [{ menuItemId: "m1", quantity: 2, name: "Bison Burger" }],
    deliveryDetails: {
      email: "creator@test.com",
      name: "Creator",
      addressLine1: "1 Test Way",
      city: "Nashville",
    },
    totalParticipants: 4,
    paidParticipants: [],
    totalAmount: 2900,
    amountPerPerson: 725,
    createdAt: new Date(),
    ...overrides,
  }).save();

const confirm = (res: any) => res.status.mock.calls[0]?.[0];

// --- tests -----------------------------------------------------------------

describe("createGroupOrder", () => {
  it("creates a group order with 4 participants and correct per-person split", async () => {
    const restaurant = await makeRestaurant();
    const user = await makeUser("auth0-creator", "creator@test.com", "Creator");

    const req: any = {
      userId: user._id.toString(),
      body: {
        restaurantId: restaurant._id.toString(),
        cartItems: [{ menuItemId: restaurant.menuItems[0]._id.toString(), quantity: "2", name: "Bison Burger" }],
      },
    };
    const res = mockRes();
    await OrderController.createGroupOrder(req, res);

    expect(confirm(res)).toBe(201);
    const body = res.json.mock.calls[0][0];
    expect(body.groupOrder.totalParticipants).toBe(4);
    expect(body.groupOrder.paidParticipants).toHaveLength(0);
    // (2 x 1200) + 500 delivery = 2900 -> 725 each
    expect(Number(body.groupOrder.amountPerPerson)).toBe(725);
    expect(body.groupOrder.status).toBe("created");

    await GroupOrder.findByIdAndDelete(body.groupOrder._id);
    await Restaurant.findByIdAndDelete(restaurant._id);
    await User.findByIdAndDelete(user._id);
  });
});

describe("confirmGroupPayment", () => {
  it("adds the payer atomically and rejects a duplicate confirm", async () => {
    const restaurant = await makeRestaurant();
    const initiator = await makeUser("auth0-i", "i@test.com", "Initiator");
    const payer = await makeUser("auth0-p", "payer@test.com", "Payer");
    const groupOrder = await makeGroupOrder(restaurant._id as any, initiator._id as any);

    const req: any = { userId: payer._id.toString(), body: { groupOrderId: groupOrder._id.toString() } };

    // First confirm -> 1/4
    const res1 = mockRes();
    await OrderController.confirmGroupPayment(req, res1);
    expect(confirm(res1)).toBe(200);
    let fresh = await GroupOrder.findById(groupOrder._id);
    expect(fresh!.paidParticipants).toHaveLength(1);

    // Duplicate confirm -> still 1/4, no double-charge
    const res2 = mockRes();
    await OrderController.confirmGroupPayment(req, res2);
    fresh = await GroupOrder.findById(groupOrder._id);
    expect(fresh!.paidParticipants).toHaveLength(1);

    await GroupOrder.findByIdAndDelete(groupOrder._id);
    await Restaurant.findByIdAndDelete(restaurant._id);
    await User.deleteMany({ _id: { $in: [initiator._id, payer._id] } });
  });

  it("marks the group order paid and creates one consolidated order at 4/4", async () => {
    const restaurant = await makeRestaurant();
    const initiator = await makeUser("auth0-x", "x@test.com", "Xavier");
    const groupOrder = await makeGroupOrder(restaurant._id as any, initiator._id as any);

    const others = [];
    for (let i = 0; i < 3; i++) {
      others.push(await makeUser(`auth0-m${i}`, `m${i}@test.com`, `Member ${i}`));
    }
    const allUsers = [initiator, ...others];

    for (const u of allUsers) {
      const req: any = { userId: u._id.toString(), body: { groupOrderId: groupOrder._id.toString() } };
      const res = mockRes();
      await OrderController.confirmGroupPayment(req, res);
      expect(confirm(res)).toBe(200);
    }

    const fresh = await GroupOrder.findById(groupOrder._id);
    expect(fresh!.status).toBe("paid");
    expect(fresh!.paidParticipants).toHaveLength(4);

    // Exactly one consolidated Order exists, linked to the group order.
    const orders = await Order.find({ groupOrderId: groupOrder._id });
    expect(orders).toHaveLength(1);
    expect(orders[0].status).toBe("paid");
    expect(orders[0].user!.toString()).toBe(initiator._id.toString());

    await Order.deleteMany({ groupOrderId: groupOrder._id });
    await GroupOrder.findByIdAndDelete(groupOrder._id);
    await Restaurant.findByIdAndDelete(restaurant._id);
    await User.deleteMany({ _id: { $in: allUsers.map((u) => u._id) } });
  });
});

describe("getGroupOrder", () => {
  it("returns group orders where the user is initiator OR a paid participant", async () => {
    const restaurant = await makeRestaurant();
    const initiator = await makeUser("auth0-a", "a@test.com", "Alice");
    const member = await makeUser("auth0-b", "b@test.com", "Bob");

    const g1 = await makeGroupOrder(restaurant._id as any, initiator._id as any);
    // g1 has member as a paid participant
    g1.paidParticipants.push({ user: member._id, email: member.email, amount: 725 });
    await g1.save();
    // g2 belongs to an unrelated user
    const stranger = await makeUser("auth0-s", "s@test.com", "Stranger");
    const g2 = await makeGroupOrder(restaurant._id as any, stranger._id as any);
    await g2.save();

    const req: any = { userId: member._id.toString() };
    const res = mockRes();
    await OrderController.getGroupOrder(req, res);
    const body = res.json.mock.calls[0][0];
    expect(body).toHaveLength(1);
    expect(body[0]._id.toString()).toBe(g1._id.toString());

    await GroupOrder.deleteMany({ _id: { $in: [g1._id, g2._id] } });
    await Restaurant.findByIdAndDelete(restaurant._id);
    await User.deleteMany({ _id: { $in: [initiator._id, member._id, stranger._id] } });
  });
});
