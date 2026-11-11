// An error the request handler turns into a response: the HTTP status, the text for the page, and
// optional fields (publicDetails is passed on to the page as it is).
function httpError(status, message, details = {}) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, details);
  return error;
}

module.exports = { httpError };
