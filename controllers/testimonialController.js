const Testimonial = require('../models/Testimonial');

// Get all testimonials (public - for landing page)
exports.getTestimonials = async (req, res) => {
  try {
    const testimonials = await Testimonial.find({ isActive: true })
      .sort({ order: 1, createdAt: -1 })
      .select('name role company avatar content rating');
    
    res.status(200).json({
      success: true,
      count: testimonials.length,
      data: testimonials
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Full management list is restricted to platform administrators.
exports.getAllTestimonialsForAdmin = async (req, res) => {
  try {
    const testimonials = await Testimonial.find()
      .sort({ order: 1, createdAt: -1 });
    res.status(200).json({
      success: true,
      count: testimonials.length,
      data: testimonials,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

// Get single testimonial
exports.getTestimonial = async (req, res) => {
  try {
    const testimonial = await Testimonial.findById(req.params.id);
    
    if (!testimonial) {
      return res.status(404).json({
        success: false,
        message: 'Testimonial not found'
      });
    }
    
    res.status(200).json({
      success: true,
      data: testimonial
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Create testimonial (admin)
exports.createTestimonial = async (req, res) => {
  try {
    const { name, role, company, avatar, content, rating, isActive, order } = req.body;
    
    const testimonial = await Testimonial.create({
      name,
      role,
      company,
      avatar,
      content,
      rating,
      isActive,
      order,
      createdBy: req.user ? req.user.id : null
    });
    
    res.status(201).json({
      success: true,
      data: testimonial
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// Update testimonial (admin)
exports.updateTestimonial = async (req, res) => {
  try {
    let testimonial = await Testimonial.findById(req.params.id);
    
    if (!testimonial) {
      return res.status(404).json({
        success: false,
        message: 'Testimonial not found'
      });
    }
    
    testimonial = await Testimonial.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    
    res.status(200).json({
      success: true,
      data: testimonial
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// Delete testimonial (admin)
exports.deleteTestimonial = async (req, res) => {
  try {
    const testimonial = await Testimonial.findById(req.params.id);
    
    if (!testimonial) {
      return res.status(404).json({
        success: false,
        message: 'Testimonial not found'
      });
    }
    
    await testimonial.deleteOne();
    
    res.status(200).json({
      success: true,
      message: 'Testimonial deleted successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
};

// Toggle testimonial active status (admin)
exports.toggleTestimonial = async (req, res) => {
  try {
    const testimonial = await Testimonial.findById(req.params.id);
    
    if (!testimonial) {
      return res.status(404).json({
        success: false,
        message: 'Testimonial not found'
      });
    }
    
    testimonial.isActive = !testimonial.isActive;
    await testimonial.save();
    
    res.status(200).json({
      success: true,
      data: testimonial
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};

// Reorder testimonials (admin)
exports.reorderTestimonials = async (req, res) => {
  try {
    const { order } = req.body; // Array of { id, order }
    
    if (!Array.isArray(order)) {
      return res.status(400).json({
        success: false,
        message: 'Order must be an array'
      });
    }
    
    // Update each testimonial's order
    const updatePromises = order.map(({ id, order: newOrder }) => 
      Testimonial.findByIdAndUpdate(id, { order: newOrder })
    );
    
    await Promise.all(updatePromises);
    
    const testimonials = await Testimonial.find().sort({ order: 1 });
    
    res.status(200).json({
      success: true,
      data: testimonials
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message
    });
  }
};
