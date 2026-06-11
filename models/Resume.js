import mongoose from "mongoose"

function defaultData() {
  return {
    basics: {
      name: "", label: "", email: "", phone: "", url: "", summary: "",
      location: { address: "", postalCode: "", city: "", countryCode: "", region: "" },
      profiles: [],
    },
    work: [], education: [], skills: [], projects: [],
    languages: [], interests: [], volunteer: [],
    awards: [], publications: [], references: [], certificates: [],
  }
}

const resumeSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  title: { type: String, default: "My Resume" },
  theme: { type: String, default: "elegant" },
  data: { type: mongoose.Schema.Types.Mixed, default: defaultData },
}, { timestamps: true })

export default mongoose.model("Resume", resumeSchema)
