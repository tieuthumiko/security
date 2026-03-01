const router = require("express").Router();
const passport = require("passport");

router.get("/", (req, res) => {
  res.render("index", { user: req.user });
});

router.get("/login", passport.authenticate("discord"));

router.get(
  "/callback",
  passport.authenticate("discord", {
    failureRedirect: "/"
  }),
  (req, res) => {
    res.redirect("/dashboard");
  }
);

router.get("/logout", (req, res) => {
  req.logout(() => {});
  res.redirect("/");
});

module.exports = router;