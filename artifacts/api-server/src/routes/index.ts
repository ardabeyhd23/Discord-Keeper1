import { Router, type IRouter } from "express";
import healthRouter from "./health";
import shopRouter from "./shop";

const router: IRouter = Router();

router.use(healthRouter);
router.use(shopRouter);

export default router;
