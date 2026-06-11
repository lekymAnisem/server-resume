import { Router } from "express"
import { createRequire } from "module"
import fs from "fs"
import path from "path"
import multer from "multer"
import auth from "../middleware/auth.js"
import Resume from "../models/Resume.js"

const require = createRequire(import.meta.url)
const router = Router()
const upload = multer({ dest: "/tmp/job-uploads" })

const JOOBLE_API = "https://jooble.org/api"
const GROQ_API = "https://api.groq.com/openai/v1/chat/completions"

async function groq(system, user) {
  const res = await fetch(GROQ_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.3,
    }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message || "AI request failed")
  return data.choices?.[0]?.message?.content || ""
}

function getResumeText(data) {
  const sections = []
  const basics = data?.basics || {}
  sections.push(
    basics.name, basics.label, basics.email, basics.phone,
    basics.url, basics.summary,
    basics.location && Object.values(basics.location).join(" ")
  )
  const sectionLabels = {
    work: "experience", education: "education", skills: "skills",
    projects: "projects", volunteer: "volunteer", awards: "awards",
    publications: "publications", certificates: "certificates",
  }
  Object.entries(sectionLabels).forEach(([section, label]) => {
    const items = Array.isArray(data?.[section]) ? data[section] : []
    if (items.length) sections.push(label)
    items.forEach((item) => {
      Object.values(item || {}).forEach((value) => {
        if (Array.isArray(value)) sections.push(value.join(" "))
        else if (value && typeof value === "object") sections.push(Object.values(value).join(" "))
        else sections.push(value)
      })
    })
  })
  return sections.filter(Boolean).join("\n")
}

function normalizeJoobleJob(job) {
  return {
    title: job.title || "",
    company: job.company || "",
    location: job.location || "",
    snippet: job.snippet || "",
    link: job.link || "",
    salary: job.salary || "",
    type: job.type || "",
    updated: job.updated || "",
    source: "Jooble",
  }
}

function normalizeJSearchJob(job) {
  return {
    title: job.job_title || "",
    company: job.employer_name || "",
    location: [job.job_city, job.job_state, job.job_country].filter(Boolean).join(", "),
    snippet: (job.job_description || "").slice(0, 300),
    link: job.job_apply_link || "",
    salary: job.job_salary || "",
    type: job.job_employment_type || "",
    updated: job.job_posted_at_datetime_utc || "",
    source: "JSearch",
  }
}

function deduplicate(jobs) {
  const seen = new Set()
  return jobs.filter((job) => {
    const key = `${job.title.toLowerCase()}|${job.company.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function fetchJooble(keywords, location) {
  try {
    const res = await fetch(`${JOOBLE_API}/${process.env.JOOBLE_API_KEY}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; ResumeBuilder/1.0)",
        Accept: "application/json",
      },
      body: JSON.stringify({ keywords: keywords || "", location: location || "" }),
    })
    if (!res.ok) {
      const text = await res.text()
      if (text.includes("Just a moment") || text.includes("challenge-platform")) {
        console.warn("Jooble API blocked by Cloudflare")
        return []
      }
      console.warn("Jooble API error:", text.slice(0, 200))
      return []
    }
    const data = await res.json()
    return (data.jobs || []).map(normalizeJoobleJob)
  } catch (err) {
    console.warn("Jooble fetch failed:", err.message)
    return []
  }
}

async function fetchJSearch(keywords, location) {
  try {
    const query = encodeURIComponent(keywords || "developer")
    const loc = location ? `&location=${encodeURIComponent(location)}` : ""
    const url = `https://jsearch.p.rapidapi.com/search-v2?query=${query}&num_pages=1&country=global&date_posted=all${loc}`

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "x-rapidapi-host": "jsearch.p.rapidapi.com",
        "x-rapidapi-key": process.env.RAPIDAPI_KEY,
      },
    })

    if (!res.ok) {
      console.warn("JSearch API error:", res.status, await res.text().catch(() => ""))
      return []
    }

    const data = await res.json()
    return (data.data || []).map(normalizeJSearchJob)
  } catch (err) {
    console.warn("JSearch fetch failed:", err.message)
    return []
  }
}

async function runAiMatching(resumeText, jobs) {
  if (!resumeText || jobs.length === 0) return jobs.map((j) => ({ ...j, matchScore: null, matchReason: "" }))

  const system = `You are a job matching assistant. Given a resume and a list of jobs, score each job's fit (0-100) based on how well the candidate's experience, skills, and background match the role. Return ONLY a JSON array of objects with keys: "title" (exact job title from input), "company" (exact company from input), "matchScore" (number 0-100), "matchReason" (short 1-sentence explanation). Do not wrap in markdown.`

  const user = `RESUME:\n${resumeText.slice(0, 4000)}\n\nJOBS:\n${jobs.map((j, i) => `${i + 1}. ${j.title} at ${j.company} — ${j.snippet || j.location || ""}`).join("\n")}`

  let matches = jobs.map((j) => ({ ...j, matchScore: null, matchReason: "" }))

  try {
    const aiText = await groq(system, user)
    const cleaned = aiText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
    const start = cleaned.indexOf("[")
    const end = cleaned.lastIndexOf("]")
    if (start !== -1 && end !== -1) {
      const parsed = JSON.parse(cleaned.slice(start, end + 1))
      if (Array.isArray(parsed)) {
        matches = jobs.map((job) => {
          const match = parsed.find((m) => m.title === job.title && m.company === job.company)
          return { ...job, matchScore: match ? match.matchScore : null, matchReason: match ? match.matchReason : "" }
        })
        matches.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0))
      }
    }
  } catch (err) {
    console.warn("AI matching fallback:", err.message)
  }

  return matches
}

router.post("/search", auth, async (req, res) => {
  try {
    const { keywords, location, resumeId } = req.body

    let resumeText = ""
    if (resumeId) {
      const resume = await Resume.findOne({ _id: resumeId, user: req.userId })
      if (!resume) return res.status(404).json({ error: "Resume not found" })
      resumeText = getResumeText(resume.data)
    }

    const [joobleJobs, jsearchJobs] = await Promise.all([
      fetchJooble(keywords, location),
      fetchJSearch(keywords, location),
    ])

    let merged = deduplicate([...joobleJobs, ...jsearchJobs]).slice(0, 40)

    if (!resumeText) {
      return res.json({ jobs: merged.map((j) => ({ ...j, matchScore: null, matchReason: "" })), totalCount: merged.length })
    }

    const matches = await runAiMatching(resumeText, merged)
    res.json({ jobs: matches, totalCount: merged.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post("/search-file", auth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" })

    const ext = path.extname(req.file.originalname).toLowerCase()
    const filePath = req.file.path
    let resumeText = ""

    if (ext === ".pdf") {
      const pdfjsLib = require("pdfjs-dist/legacy/build/pdf")
      const buf = fs.readFileSync(filePath)
      const data = new Uint8Array(buf)
      const doc = await pdfjsLib.getDocument({ data }).promise
      const pages = []
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i)
        const content = await page.getTextContent()
        pages.push(content.items.map((item) => item.str).join(" "))
      }
      resumeText = pages.join("\n")
    } else if (ext === ".docx") {
      const mammoth = await import("mammoth")
      const buf = fs.readFileSync(filePath)
      const result = await mammoth.extractRawText({ buffer: buf })
      resumeText = result.value
    } else {
      fs.unlinkSync(filePath)
      return res.status(400).json({ error: "Unsupported file type. Use .pdf or .docx" })
    }

    fs.unlinkSync(filePath)

    if (!resumeText.trim()) {
      return res.status(400).json({ error: "Could not extract text from file" })
    }

    const { keywords, location } = req.body

    const [joobleJobs, jsearchJobs] = await Promise.all([
      fetchJooble(keywords, location),
      fetchJSearch(keywords, location),
    ])

    let merged = deduplicate([...joobleJobs, ...jsearchJobs]).slice(0, 40)

    if (!resumeText) {
      return res.json({ jobs: merged.map((j) => ({ ...j, matchScore: null, matchReason: "" })), totalCount: merged.length })
    }

    const matches = await runAiMatching(resumeText, merged)
    res.json({ jobs: matches, totalCount: merged.length })
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path)
    res.status(500).json({ error: err.message })
  }
})

export default router
