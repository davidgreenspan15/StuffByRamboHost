(function initializeVariationEffects() {
  "use strict";

  const revealElements = document.querySelectorAll(".reveal");
  const scrollContainer = document.querySelector(".snap-container");

  if ("IntersectionObserver" in window) {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
        }
      });
    }, { threshold: 0.05, root: scrollContainer || null });
    revealElements.forEach((element) => revealObserver.observe(element));
  } else {
    revealElements.forEach((element) => element.classList.add("visible"));
  }

  document.querySelectorAll(".tile").forEach((tile) => {
    tile.addEventListener("mousemove", (event) => {
      const bounds = tile.getBoundingClientRect();
      tile.style.setProperty("--mx", `${event.clientX - bounds.left}px`);
      tile.style.setProperty("--my", `${event.clientY - bounds.top}px`);
    });
  });

  const dots = document.querySelectorAll(".dot-nav a[data-section]");
  const sections = document.querySelectorAll("section[data-section]");
  if (dots.length && sections.length && "IntersectionObserver" in window) {
    const sectionObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) {
          return;
        }
        dots.forEach((dot) => dot.classList.remove("active"));
        const activeDot = document.querySelector(`.dot-nav a[data-section="${entry.target.dataset.section}"]`);
        if (activeDot) {
          activeDot.classList.add("active");
        }
      });
    }, { threshold: 0.4, root: scrollContainer || null });
    sections.forEach((section) => sectionObserver.observe(section));
  }

  dots.forEach((dot) => {
    dot.addEventListener("click", (event) => {
      const selector = dot.getAttribute("href");
      const target = selector && selector.startsWith("#") ? document.querySelector(selector) : null;
      if (!target) {
        return;
      }
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth" });
    });
  });
})();
