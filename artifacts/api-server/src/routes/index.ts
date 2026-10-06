import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import healthRouter from "./health";
import adminRouter from "./blacktrading/admin";
import analyticsAdminRouter from "./blacktrading/analytics";
import publicRouter from "./blacktrading/public";
import { sameOriginForWrites } from "../middlewares/sameOrigin";

const router: IRouter = Router();
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

router.use(apiLimiter, sameOriginForWrites);
router.use(healthRouter, publicRouter, analyticsAdminRouter, adminRouter);

export default router;
