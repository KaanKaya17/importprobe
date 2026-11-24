// Project-level augmentation: req.user must not be reported as made up.
declare global {
  namespace Express {
    interface Request {
      user?: { id: string };
    }
  }
}
export {};
