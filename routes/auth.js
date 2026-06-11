import { Router } from "express"
import jwt from "jsonwebtoken"
import User from "../models/User.js"
import auth from "../middleware/auth.js"

const router = Router()

function signToken(id) {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "7d" })
}

router.post("/signup", async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body
    if (!firstName || !email || !password) {
      return res.status(400).json({ error: "First name, email, and password are required" })
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" })
    }
    const existing = await User.findOne({ email })
    if (existing) {
      return res.status(400).json({ error: "Email already in use" })
    }
    const user = await User.create({ firstName, lastName, email, password })
    const token = signToken(user._id)
    res.status(201).json({ token, user })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post("/signin", async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" })
    }
    const user = await User.findOne({ email })
    if (!user) {
      return res.status(400).json({ error: "Invalid email or password" })
    }
    const match = await user.comparePassword(password)
    if (!match) {
      return res.status(400).json({ error: "Invalid email or password" })
    }
    const token = signToken(user._id)
    res.json({ token, user })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.get("/me", auth, async (req, res) => {
  try {
    const user = await User.findById(req.userId)
    if (!user) return res.status(404).json({ error: "User not found" })
    res.json({ user })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
