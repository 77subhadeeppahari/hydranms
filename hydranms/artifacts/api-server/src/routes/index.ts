import { Router, type IRouter } from "express";
import healthRouter from "./health";
import nmsRouter from "./nms";

const router: IRouter = Router();

router.use(healthRouter);
router.use(nmsRouter);

export default router;
