import express from "express";

import { loginUser, signupUser } from "../modules/user/controller.js";

const router = express.Router();

router.post("/auth/signup", signupUser);
router.post("/auth/login", loginUser);

export default router;
