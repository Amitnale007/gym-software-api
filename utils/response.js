export const successResponse = (res,
    message,
    data = {},
    pagination = null,
    summary = null,
    statusCode = 200
) => {
    return res.status(statusCode).json({
        success: true,
        message,
        data,
        ...(pagination && { pagination }),
        ...(summary && { summary }),
    });
};

export const errorResponse = (
    res,
    message = "Internal Server Error",
    error = {},
    statusCode = 500
) => {
    return res.status(statusCode).json({
        success: false,
        message,
        error,
    });
};