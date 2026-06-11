import "dotenv/config"
import express from "express"
import mongoose from "mongoose"
import cors from "cors"
import authRoutes from "./routes/auth.js"
import resumeRoutes from "./routes/resume.js"
import aiRoutes from "./routes/ai.js"
import atsRoutes from "./routes/ats.js"
import jobRoutes from "./routes/jobs.js"

const app = express()
const PORT = process.env.PORT || 5000

app.use(cors())
app.use(express.json())

app.use("/api/auth", authRoutes)
app.use("/api/resumes", resumeRoutes)
app.use("/api/ai", aiRoutes)
app.use("/api/ats", atsRoutes)
app.use("/api/jobs", jobRoutes)

app.get("/api/health", (_, res) => res.json({ status: "ok" }))

app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err)
  const status = err.status || err.statusCode || 500
  res.status(status).json({ error: err.message || "Internal server error" })
})

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("Connected to MongoDB Atlas"))
  .catch((err) => console.error("MongoDB connection error:", err.message))

app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
