import crypto from "crypto";
import mongoose from "mongoose";

import User from "../../db/schema/user.js";
import jwt from "jsonwebtoken";

const hashPassword = (password) => {
  return crypto.createHash("sha256").update(String(password)).digest("hex");
};

const sanitizeUser = (user) => {
  const plainUser = user.toObject ? user.toObject() : { ...user };
  delete plainUser.password;
  return plainUser;
};

const issueToken = (user) => jwt.sign(
  { sub: String(user._id), role: user.role },
  process.env.JWT_SECRET,
  { expiresIn: "1d" }
);

const signupUser = (req, res) => {
  req.body = { ...req.body, role: "user" };
  return createUser(req, res);
};

const loginUser = async (req, res) => {
  try {
    const email = String(req.body.email).trim().toLowerCase();
    const password = String(req.body.password);

    if((!email || !String(email).trim()) || (!password || !String(password).trim())){
      return res.status(401).json({ success: false, error: "Both email and password required" });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(401).json({ success: false, error: "No user found with given credentials" });
    }

    if(!user.isActive){
      return res.status(401).json({ success: false, error: "Inactive user" });
    }

    if(hashPassword(password) !== user.password){
      return res.status(401).json({ success: false, error: "Invalid password" });
    }

    return res.status(200).json({ success: true, token: issueToken(user), result: sanitizeUser(user) });
  } catch (error) {
    console.error("User login failed:", error);
    return res.status(500).json({ success: false, error: "Internal server error." });
  }
};

const createUser = async (req, res) => {
  try {
    const { name, email, password, role, isActive } = req.body;

    if (!name || !String(name).trim()) return res.status(400).json({ success: false, error: "Name is required." });
    else if(!email || !String(name).trim()) return res.status(400).json({ success: false, error: "Email is required." });
    else if(!password || !String(name).trim()) return res.status(400).json({ success: false, error: "Password is required." });
    else if(!role || !String(name).trim()) return res.status(400).json({ success: false, error: "Role is required." });

    const normalizedEmail = String(email ?? "").trim().toLowerCase();
    if (!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return res.status(400).json({ success: false, error: "A valid email is required." });
    }

    if (!password || String(password).length < 6) {
      return res.status(400).json({
        success: false,
        error: "Password is required and must be at least 6 characters long.",
      });
    }

    const existingUser = await User.findOne({ email: normalizedEmail });
    if (existingUser) {
      return res.status(409).json({ success: false, error: "User with this email already exists." });
    }

    const user = await User.create({
      name: String(name).trim(),
      email: normalizedEmail,
      password: hashPassword(password),
      role: role ?? "user",
      isActive: typeof isActive === "boolean" ? isActive : true,
    });

    return res.status(201).json({
      success: true,
      result: sanitizeUser(user),
    });
  } catch (error) {
    console.error("User creation failed:", error);
    return res.status(500).json({ success: false, error: "Internal server error." });
  }
};

const readUsers = async (req, res) => {
  try {
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);

    const filter = {};
    const search = String(req.query.search || "").trim();

    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    return res.status(200).json({
      success: true,
      result: users.map((user) => {
        const { password, ...safeUser } = user;
        return safeUser;
      }),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("User list fetch failed:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch users." });
  }
};

const readUser = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: "Invalid user id." });
    }

    const user = await User.findById(id).lean();
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found." });
    }

    const { password, ...safeUser } = user;
    return res.status(200).json({ success: true, result: safeUser });
  } catch (error) {
    console.error("User fetch failed:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch user." });
  }
};

const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, password, role, isActive } = req.body;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: "Invalid user id." });
    }

    const update = {};

    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.status(400).json({ success: false, error: "Name cannot be empty." });
      }
      update.name = String(name).trim();
    }

    if (email !== undefined) {
      const normalizedEmail = String(email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
        return res.status(400).json({ success: false, error: "A valid email is required." });
      }

      const existingUser = await User.findOne({ email: normalizedEmail, _id: { $ne: id } });
      if (existingUser) {
        return res.status(409).json({ success: false, error: "User with this email already exists." });
      }

      update.email = normalizedEmail;
    }

    if (password !== undefined) {
      if (String(password).length < 6) {
        return res.status(400).json({
          success: false,
          error: "Password must be at least 6 characters long.",
        });
      }
      update.password = hashPassword(password);
    }

    if (role !== undefined) {
      update.role = role;
    }

    if (isActive !== undefined) {
      update.isActive = Boolean(isActive);
    }

    const user = await User.findByIdAndUpdate(id, update, { new: true, runValidators: true });
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found." });
    }

    return res.status(200).json({ success: true, result: sanitizeUser(user) });
  } catch (error) {
    console.error("User update failed:", error);
    return res.status(500).json({ success: false, error: "Failed to update user."});
  }
};

const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ success: false, error: "Invalid user id." });
    }

    const user = await User.findByIdAndUpdate(
      id,
      { isActive: false },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found." });
    }

    return res.status(200).json({
      success: true,
      result: {
        _id: user._id,
        isActive: user.isActive,
        message: "User deactivated successfully.",
      },
    });
  } catch (error) {
    console.error("User deletion failed:", error);
    return res.status(500).json({ success: false, error: "Failed to delete user." });
  }
};

export { createUser, signupUser, loginUser, readUsers, readUser, updateUser, deleteUser };
