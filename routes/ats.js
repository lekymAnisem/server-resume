import { Router } from "express"
import { createRequire } from "module"
import fs from "fs"
import path from "path"
import multer from "multer"
import auth from "../middleware/auth.js"
import Resume from "../models/Resume.js"

const require = createRequire(import.meta.url)
const upload = multer({ dest: "/tmp/ats-uploads" })

const router = Router()

const GROQ_API = "https://api.groq.com/openai/v1/chat/completions"

async function groq(system, user) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is not configured")
  }

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
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error("Empty AI response")
  return text
}

function cleanWords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/^-+|-+$/g, ""))
    .filter((word) => word.length > 2)
}

function getResumeText(data) {
  const sections = []
  const basics = data?.basics || {}

  sections.push(
    basics.name,
    basics.label,
    basics.email,
    basics.phone,
    basics.url,
    basics.summary,
    basics.location && Object.values(basics.location).join(" ")
  )

  const sectionLabels = {
    work: "experience",
    education: "education",
    skills: "skills",
    projects: "projects",
    volunteer: "volunteer",
    awards: "awards",
    publications: "publications",
    certificates: "certificates",
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

function calculateATSScore(resumeText) {
  const atsKeywords = [
    "achieved", "analyzed", "built", "collaborated", "created", "delivered",
    "designed", "developed", "implemented", "improved", "increased", "launched",
    "led", "managed", "optimized", "reduced", "resolved", "streamlined"
  ]
  const resumeWords = cleanWords(resumeText)
  const resumeWordSet = new Set(resumeWords)
  const matchedKeywords = atsKeywords.filter((word) => resumeWordSet.has(word))
  const missingKeywords = atsKeywords.filter((word) => !resumeWordSet.has(word))
  const keywordMatch = Math.round((matchedKeywords.length / atsKeywords.length) * 100)

  const resumeLength = resumeWords.length
  const lengthScore = resumeLength < 250
    ? Math.round((resumeLength / 250) * 100)
    : resumeLength <= 800
      ? 100
      : Math.max(55, Math.round(100 - ((resumeLength - 800) / 10)))
  const hasEmail = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(resumeText)
  const hasPhone = /(?:\+?\d[\d\s().-]{7,}\d)/.test(resumeText)
  const contactScore = hasEmail && hasPhone ? 100 : hasEmail || hasPhone ? 60 : 0
  const sectionNames = ["experience", "education", "skills", "project", "summary"]
  const structureScore = Math.round(
    (sectionNames.filter((section) => resumeText.toLowerCase().includes(section)).length / sectionNames.length) * 100
  )
  const totalScore = (keywordMatch * 0.45) + (lengthScore * 0.2) + (contactScore * 0.15) + (structureScore * 0.2)

  return {
    score: Math.min(Math.round(totalScore), 100),
    breakdown: {
      keywordMatch,
      length: lengthScore,
      contactInfo: contactScore,
      structure: structureScore,
    },
    resumeKeywordCount: matchedKeywords.length,
    jobKeywordCount: atsKeywords.length,
    matchedKeywords,
    missingKeywords: missingKeywords.slice(0, 12),
  }
}

function generateRecommendations(atsData, resumeText) {
  const recommendations = []

  if (atsData.breakdown.keywordMatch < 70) {
    recommendations.push({
      type: "critical",
      title: "Add Strong ATS Keywords",
      description: atsData.missingKeywords.length
        ? `Add action-focused keywords such as ${atsData.missingKeywords.join(", ")} where they honestly fit.`
        : "Add more action-focused keywords to improve your ATS score."
    })
  }

  if (atsData.breakdown.length < 80) {
    recommendations.push({
      type: "important",
      title: "Optimize Resume Length",
      description: `Your resume is ${cleanWords(resumeText).length} words. Aim for 300-800 words for optimal ATS performance.`
    })
  }

  if (atsData.breakdown.contactInfo < 100) {
    recommendations.push({
      type: "important",
      title: "Add Complete Contact Information",
      description: "Include both a professional email address and phone number so recruiters can reach you."
    })
  }

  if (atsData.breakdown.structure < 80) {
    recommendations.push({
      type: "suggestion",
      title: "Improve Structure",
      description: "Use clear section headers and consistent formatting for better readability and ATS parsing."
    })
  }

  if (atsData.score >= 80) {
    recommendations.push({
      type: "success",
      title: "Great ATS Score!",
      description: "Your resume is well-optimized for applicant tracking systems. Keep up the good work!"
    })
  }

  return recommendations
}

function fallbackAnalysis(atsData) {
  const matchLevel = atsData.score >= 85 ? "Excellent" : atsData.score >= 70 ? "Good" : atsData.score >= 55 ? "Fair" : "Poor"

  return {
    score: atsData.score,
    strengths: [
      atsData.breakdown.structure >= 80 ? "Clear resume sections" : "Resume content is readable",
      atsData.breakdown.contactInfo >= 100 ? "Complete contact information" : "Includes resume content for ATS parsing"
    ],
    weaknesses: atsData.missingKeywords.length
      ? [`Missing strong ATS keywords: ${atsData.missingKeywords.slice(0, 6).join(", ")}`]
      : [],
    recommendations: [],
    matchLevel,
    breakdown: {
      keywordMatch: atsData.breakdown.keywordMatch,
      contentQuality: atsData.breakdown.length,
      structure: atsData.breakdown.structure,
      formatting: Math.max(atsData.breakdown.structure, 70),
    }
  }
}

router.post("/analyze-file", auth, upload.single("file"), async (req, res) => {
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
        pages.push(content.items.map(item => item.str).join(" "))
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
      return res.status(400).json({ error: "Could not extract any text from the file" })
    }

    const atsData = calculateATSScore(resumeText)

    const system = `You are an expert ATS (Applicant Tracking System) analyzer. Analyze the resume by itself and provide:
1. A score from 0-100 based on ATS readiness, keyword strength, content quality, and structure
2. Specific recommendations for improvement
3. Key strengths and weaknesses
4. Match level (Excellent, Good, Fair, Poor)

Return the analysis as JSON with these fields: score, strengths, weaknesses, recommendations, matchLevel, breakdown (keywordMatch, contentQuality, structure, formatting).`

    const user = `Resume: ${resumeText}

Analyze this resume for general ATS readiness and provide a comprehensive ATS analysis.`

    let analysis = fallbackAnalysis(atsData)
    try {
      const analysisText = await groq(system, user)
      const cleaned = analysisText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
      const start = cleaned.indexOf("{")
      const end = cleaned.lastIndexOf("}")
      if (start !== -1 && end !== -1) {
        const parsed = JSON.parse(cleaned.slice(start, end + 1))
        analysis = {
          ...analysis,
          ...parsed,
          score: Number(parsed.score) || atsData.score,
          breakdown: {
            ...analysis.breakdown,
            ...(parsed.breakdown || {}),
          },
        }
      } else {
        throw new Error("No JSON found in AI response")
      }
    } catch (err) {
      console.warn("ATS AI analysis fallback:", err.message)
    }

    const recommendations = generateRecommendations(atsData, resumeText)

    res.json({
      atsScore: atsData.score,
      atsBreakdown: atsData.breakdown,
      analysis,
      recommendations,
      resumeText,
    })
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path)
    res.status(500).json({ error: err.message })
  }
})

router.post("/analyze", auth, async (req, res) => {
  try {
    const { resumeId } = req.body

    if (!resumeId) {
      return res.status(400).json({ error: "Resume ID is required" })
    }

    const resume = await Resume.findOne({ _id: resumeId, user: req.userId })
    if (!resume) return res.status(404).json({ error: "Resume not found" })

    const resumeText = getResumeText(resume.data)
    const atsData = calculateATSScore(resumeText)

    const system = `You are an expert ATS (Applicant Tracking System) analyzer. Analyze the resume by itself and provide:
1. A score from 0-100 based on ATS readiness, keyword strength, content quality, and structure
2. Specific recommendations for improvement
3. Key strengths and weaknesses
4. Match level (Excellent, Good, Fair, Poor)

Return the analysis as JSON with these fields: score, strengths, weaknesses, recommendations, matchLevel, breakdown (keywordMatch, contentQuality, structure, formatting).`

    const user = `Resume: ${resumeText}

Analyze this resume for general ATS readiness and provide a comprehensive ATS analysis.`

    let analysis = fallbackAnalysis(atsData)
    try {
      const analysisText = await groq(system, user)
      const cleaned = analysisText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim()
      const start = cleaned.indexOf("{")
      const end = cleaned.lastIndexOf("}")
      if (start !== -1 && end !== -1) {
        const parsed = JSON.parse(cleaned.slice(start, end + 1))
        analysis = {
          ...analysis,
          ...parsed,
          score: Number(parsed.score) || atsData.score,
          breakdown: {
            ...analysis.breakdown,
            ...(parsed.breakdown || {}),
          },
        }
      } else {
        throw new Error("No JSON found in AI response")
      }
    } catch (err) {
      console.warn("ATS AI analysis fallback:", err.message)
    }

    const recommendations = generateRecommendations(atsData, resumeText)

    res.json({
      atsScore: atsData.score,
      atsBreakdown: atsData.breakdown,
      analysis,
      recommendations,
      resumeText,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
