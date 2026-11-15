import { Request, Response, NextFunction } from "express";
import { ZodSchema, ZodError } from "zod";

export interface ValidationTargets {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}

export function validate(schemas: ValidationTargets) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        const parsedQuery = schemas.query.parse(req.query);
        Object.defineProperty(req, "query", {
          value: parsedQuery,
          writable: true,
          enumerable: true,
          configurable: true
        });
      }
      if (schemas.params) {
        const parsedParams = schemas.params.parse(req.params);
        try {
          req.params = parsedParams as any;
        } catch {
          Object.defineProperty(req, "params", {
            value: parsedParams,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return next();
    } catch (err) {
      if (err instanceof ZodError) {
        const issues = err.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message
        }));

        return res.status(400).json({
          error: issues[0]?.message || "Validation failed",
          details: issues
        });
      }
      return next(err);
    }
  };
}
