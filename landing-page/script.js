// Register ScrollTrigger plugin
gsap.registerPlugin(ScrollTrigger);

// 1. Initial Setup
// Laptop starts scaled up, covering the screen, and angled down slightly
gsap.set(".laptop-wrapper", {
    scale: 3,
    y: "40vh",
    rotateX: 60, // Angled keyboard base
});
gsap.set(".laptop-lid", {
    rotateX: -160, // Lid is closed
});

// Calculate inner scroll distance dynamically
function getScrollDistance() {
    const innerContent = document.querySelector(".inner-website");
    const screenWrapper = document.querySelector(".laptop-lid");
    if(!innerContent || !screenWrapper) return 0;
    
    // We scroll up by the difference between content height and the visible screen height
    const distance = innerContent.offsetHeight - screenWrapper.offsetHeight;
    return distance > 0 ? -distance : 0;
}

// 2. Main Timeline tied to the .laptop-section scroll
const tl = gsap.timeline({
    scrollTrigger: {
        trigger: ".laptop-section",
        start: "top top", 
        end: "bottom bottom",
        scrub: 1, // Smooth scrubbing
        invalidateOnRefresh: true, // Recalculates sizes on resize
    }
});

// A. Fade out the introductory text
tl.to(".intro", { opacity: 0, duration: 1 }, 0);

// B. Laptop zooms out and lid opens
tl.to(".laptop-wrapper", {
    scale: 1,
    y: "0vh",
    rotateX: 0,
    duration: 3,
    ease: "power2.inOut"
}, 0);

tl.to(".laptop-lid", {
    rotateX: 0, // Lid opens fully (0 degrees relative to wrapper)
    duration: 3,
    ease: "power2.inOut"
}, 0);

// C. Scroll the website content inside the laptop screen
// We use a longer duration here to give the user time to read the content while scrolling
tl.to(".inner-website", {
    y: () => getScrollDistance(),
    duration: 10,
    ease: "none"
}, 3); // Starts after laptop is fully open

// D. Laptop closes and zooms out further at the end of the scroll
tl.to(".laptop-lid", {
    rotateX: -160, // Close lid again
    duration: 2.5,
    ease: "power2.inOut"
}, 13.5);

tl.to(".laptop-wrapper", {
    scale: 0.6,
    y: "-30vh",
    opacity: 0, // Fade out the laptop entirely
    duration: 2.5,
    ease: "power2.inOut"
}, 13.5);

// 3. Outro Timeline
// This brings in the final "TECH DEFENDERS OS" text and CTA button
const outroTl = gsap.timeline({
    scrollTrigger: {
        trigger: ".outro",
        start: "top center",
        end: "center center",
        scrub: 1
    }
});

outroTl.to(".outro-content", {
    opacity: 1,
    scale: 1,
    duration: 1,
    ease: "back.out(1.5)" // Small bounce effect
});

