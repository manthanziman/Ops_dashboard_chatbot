import express from "express";

import {
  createUser,
  readUsers,
  readUser,
  updateUser,
  deleteUser,
} from "../modules/user/controller.js";

const router = express.Router();

router.post("/users", createUser);
router.get("/users", readUsers);
router.get("/users/:id", readUser);
router.put("/users/:id", updateUser);
router.delete("/users/:id", deleteUser);

export default router;
