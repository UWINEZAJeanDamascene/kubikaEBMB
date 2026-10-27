const Category = require('../models/Category');
const Product = require('../models/Product');
const { dbClient } = require('../lib/prisma');

const CATEGORY_FIELDS = ['name', 'description', 'parent', 'defaultInventoryAccount', 'defaultCogsAccount', 'defaultRevenueAccount', 'isActive', 'customFields'];

function normalizeCategoryPayload(body = {}) {
  const payload = {};
  for (const field of CATEGORY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(body, field)) payload[field] = body[field];
  }
  if (payload.name !== undefined) payload.name = String(payload.name || '').trim();
  if (payload.description !== undefined && payload.description !== null) payload.description = String(payload.description).trim();
  if (payload.parent === '') payload.parent = null;
  return payload;
}

async function validateParent(companyId, parentId, categoryId = null) {
  if (!parentId) return null;
  const visited = new Set();
  let currentId = String(parentId);
  while (currentId) {
    if (categoryId && currentId === String(categoryId)) return 'A category cannot be its own parent or a descendant of itself';
    if (visited.has(currentId)) return 'The selected parent has an invalid category cycle';
    visited.add(currentId);
    const parent = await Category.findOne({ _id: currentId, company: companyId }).select('_id parent').lean();
    if (!parent) return 'Parent category not found';
    currentId = parent.parent ? String(parent.parent) : null;
  }
  return null;
}

async function validateSiblingName(companyId, name, parentId, excludedId = null) {
  if (!name) return 'Category name is required';
  const siblings = await Category.find({ company: companyId, parent: parentId || null }).select('_id name').lean();
  const duplicate = siblings.some((item) => String(item._id) !== String(excludedId || '') && String(item.name).trim().toLocaleLowerCase() === name.toLocaleLowerCase());
  return duplicate ? 'A category with this name already exists under the selected parent' : null;
}

// @desc    Get all categories
// @route   GET /api/categories
// @access  Private
exports.getCategories = async (req, res, next) => {
  try {
    const { isActive } = req.query;
    const companyId = req.user.company._id;
    const query = { company: companyId };
    
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    // Return categories as a nested tree (max depth 3). Picker mode skips unused joins.
    const categoryQuery = Category.find(query)
      .select(req.query.forPicker === '1' ? '_id name parent isActive' : '-customFields')
      .sort({ name: 1 });
    if (req.query.forPicker !== '1') {
      categoryQuery.populate('createdBy', 'name email');
    }
    const categories = await categoryQuery.lean();

    // Group once by category so the list/tree can show per-category product
    // totals without issuing one count query per category. Keep the company
    // predicate explicit, even though this read is also tenant-scoped.
    const productCounts = req.query.forPicker !== '1' && categories.length
      ? await dbClient().product.groupBy({
        by: ['categoryId'],
        where: {
          companyId: String(companyId),
          categoryId: { in: categories.map((category) => String(category._id)) },
        },
        _count: { _all: true },
      })
      : [];
    const productCountByCategory = new Map(
      productCounts.map((row) => [String(row.categoryId), row._count._all]),
    );

    const map = new Map();
    categories.forEach((c) => map.set(String(c._id), Object.assign(c, {
      children: [],
      productsCount: productCountByCategory.get(String(c._id)) || 0,
    })));

    const roots = [];
    for (const c of categories) {
      if (c.parent) {
        const p = map.get(String(c.parent));
        if (p) p.children.push(map.get(String(c._id)));
        else roots.push(map.get(String(c._id)));
      } else {
        roots.push(map.get(String(c._id)));
      }
    }

    res.json({
      success: true,
      count: categories.length,
      data: roots
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single category
// @route   GET /api/categories/:id
// @access  Private
exports.getCategory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    const category = await Category.findOne({ _id: req.params.id, company: companyId })
      .populate('createdBy', 'name email');

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    // Get products count in this category
    const productsCount = await Product.countDocuments({ category: req.params.id, company: companyId });

    res.json({
      success: true,
      data: {
        ...category.toObject(),
        productsCount
      }
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Create new category
// @route   POST /api/categories
// @access  Private (admin, stock_manager)
exports.createCategory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const payload = normalizeCategoryPayload(req.body);
    const nameError = await validateSiblingName(companyId, payload.name, payload.parent);
    if (nameError) return res.status(400).json({ success: false, message: nameError });
    const parentError = await validateParent(companyId, payload.parent);
    if (parentError) return res.status(400).json({ success: false, message: parentError });

    const category = await Category.create({ ...payload, company: companyId, createdBy: req.user.id });

    res.status(201).json({
      success: true,
      data: category
    });
  } catch (error) {
    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Category with this name already exists'
      });
    } else if (error.name === 'MaxNestingDepth') {
      return res.status(400).json({ success: false, message: error.message });
    }
    next(error);
  }
};

// @desc    Update category
// @route   PUT /api/categories/:id
// @access  Private (admin, stock_manager)
exports.updateCategory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    const payload = normalizeCategoryPayload(req.body);
    let category = await Category.findOne({ _id: req.params.id, company: companyId });
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }
    const nextParent = Object.prototype.hasOwnProperty.call(payload, 'parent') ? payload.parent : category.parent;
    const nextName = payload.name === undefined ? category.name : payload.name;
    const nameError = await validateSiblingName(companyId, nextName, nextParent, category._id);
    if (nameError) return res.status(400).json({ success: false, message: nameError });
    const parentError = await validateParent(companyId, nextParent, category._id);
    if (parentError) return res.status(400).json({ success: false, message: parentError });

    Object.assign(category, payload);
    await category.save();

    category = await Category.findOne({ _id: category._id, company: companyId }).populate('createdBy', 'name email');

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    res.json({
      success: true,
      data: category
    });
  } catch (error) {
    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: 'Category with this name already exists'
      });
    }
    next(error);
  }
};

// @desc    Delete category
// @route   DELETE /api/categories/:id
// @access  Private (admin)
exports.deleteCategory = async (req, res, next) => {
  try {
    const companyId = req.user.company._id;
    
    // Check if category has products
    const productsCount = await Product.countDocuments({ category: req.params.id, company: companyId });

    const childrenCount = await Category.countDocuments({ parent: req.params.id, company: companyId });

    if (productsCount > 0 || childrenCount > 0) {
        return res.status(409).json({
          success: false,
          code: 'CATEGORY_IN_USE',
          message: `Cannot delete category while it has ${productsCount} product(s) or ${childrenCount} child categor${childrenCount === 1 ? 'y' : 'ies'}. Reassign or remove them first.`
        });
    }

    const category = await Category.findOneAndDelete({ _id: req.params.id, company: companyId });

    if (!category) {
      return res.status(404).json({
        success: false,
        message: 'Category not found'
      });
    }

    res.json({
      success: true,
      message: 'Category deleted successfully'
    });
  } catch (error) {
    next(error);
  }
};
