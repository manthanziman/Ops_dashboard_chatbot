import jwt from "jsonwebtoken";
import User from "../db/schema/user.js";

const getJwtSecret = () => {
  if (!process.env.JWT_SECRET) {
    throw new Error("JWT_SECRET is not configured.");
  }
  return process.env.JWT_SECRET;
};

const authenticate = async (req, res, next) => {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ success: false, error: "Authentication is required." });
    }

    const payload = jwt.verify(token, getJwtSecret());
    const user = await User.findOne({ _id: payload.sub, isActive: true }).select("-password").lean();

    if (!user) {
      return res.status(401).json({ success: false, error: "User is inactive or does not exist." });
    }

    req.user = user;
    return next();
  } catch (error) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, error: "Invalid or expired token." });
    }
    return res.status(500).json({ success: false, error: "Failed to authenticate user." });
  }
};

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return res.status(403).json({ success: false, error: "You do not have permission to perform this action." });
  }
  return next();
};

export { authenticate, requireRole };
