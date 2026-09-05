import express from "express";

import {
  signupUser,
  readUsers,
  readUser,
  updateUser,
  deleteUser,
} from "../modules/user/controller.js";
import { authenticate, requireRole } from "../middleware/auth.js";

const router = express.Router();

router.post("/users", signupUser);
router.use("/users", authenticate, requireRole("admin"));
router.get("/users", readUsers);
router.get("/users/:id", readUser);
router.put("/users/:id", updateUser);
router.delete("/users/:id", deleteUser);

export default router;
