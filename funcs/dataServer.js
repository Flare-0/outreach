/**
 * Data API Server for YC Companies Data
 * Efficiently serves the 20MB JSON file via REST API
 * 
 * Usage: node funcs/dataServer.js
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Cache for companies data
let companiesCache = null;
let cacheLoadTime = null;

/**
 * Load companies data from JSON file
 * Only loads once and caches in memory
 */
function loadCompaniesData() {
    if (companiesCache && cacheLoadTime) {
        const elapsed = Date.now() - cacheLoadTime;
        // Reload cache every 5 minutes to pick up any changes
        if (elapsed < 5 * 60 * 1000) {
            return companiesCache;
        }
    }

    try {
        const dataPath = path.join(__dirname, '..', 'ycURL_with_crawler_data.json');
        console.log(`Loading data from: ${dataPath}`);
        
        const startTime = Date.now();
        const rawData = fs.readFileSync(dataPath, 'utf8');
        const loadTime = Date.now() - startTime;
        
        companiesCache = JSON.parse(rawData);
        cacheLoadTime = Date.now();
        
        console.log(`✓ Loaded ${companiesCache.length} companies in ${loadTime}ms`);
        return companiesCache;
    } catch (error) {
        console.error('Error loading companies data:', error);
        throw new Error('Failed to load companies data');
    }
}

/**
 * API: Get all companies
 * Endpoint: GET /api/companies
 */
app.get('/api/companies', (req, res) => {
    try {
        const companies = loadCompaniesData();
        res.json(companies);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * API: Get paginated companies
 * Endpoint: GET /api/companies/paginated?page=1&limit=25
 */
app.get('/api/companies/paginated', (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 25;
        
        const companies = loadCompaniesData();
        
        const start = (page - 1) * limit;
        const end = start + limit;
        
        res.json({
            data: companies.slice(start, end),
            page,
            limit,
            total: companies.length,
            pages: Math.ceil(companies.length / limit)
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * API: Get company by index
 * Endpoint: GET /api/companies/:id
 */
app.get('/api/companies/:id', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const companies = loadCompaniesData();
        
        if (id < 0 || id >= companies.length) {
            return res.status(404).json({ error: 'Company not found' });
        }
        
        res.json(companies[id]);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * API: Get statistics
 * Endpoint: GET /api/stats
 */
app.get('/api/stats', (req, res) => {
    try {
        const companies = loadCompaniesData();
        
        const stats = {
            totalCompanies: companies.length,
            typeDistribution: {},
            batchDistribution: {},
            locationDistribution: {},
            industriesPresent: new Set(),
            totalCrawledPages: 0
        };
        
        companies.forEach(company => {
            // Type Distribution
            const type = company.Type || 'Unknown';
            stats.typeDistribution[type] = (stats.typeDistribution[type] || 0) + 1;
            
            // Batch Distribution
            const batch = company.Batch || 'Unknown';
            stats.batchDistribution[batch] = (stats.batchDistribution[batch] || 0) + 1;
            
            // Location Distribution
            const location = company.Location || 'Unknown';
            stats.locationDistribution[location] = (stats.locationDistribution[location] || 0) + 1;
            
            // Industries
            if (company.Industry) {
                stats.industriesPresent.add(company.Industry);
            }
            
            // Crawled Pages
            if (company.crawlerData && Array.isArray(company.crawlerData)) {
                stats.totalCrawledPages += company.crawlerData.length;
            }
        });
        
        stats.industriesPresent = Array.from(stats.industriesPresent);
        stats.uniqueIndustries = stats.industriesPresent.length;
        
        res.json(stats);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * API: Search companies
 * Endpoint: GET /api/search?q=query&type=filter&batch=filter
 */
app.get('/api/search', (req, res) => {
    try {
        const query = (req.query.q || '').toLowerCase();
        const typeFilter = req.query.type || '';
        const batchFilter = req.query.batch || '';
        const locationFilter = req.query.location || '';
        
        let companies = loadCompaniesData();
        
        // Apply filters
        companies = companies.filter(company => {
            let match = true;
            
            // Search query
            if (query) {
                match = match && (
                    company.Name.toLowerCase().includes(query) ||
                    (company.Discription && company.Discription.toLowerCase().includes(query)) ||
                    (company.Location && company.Location.toLowerCase().includes(query)) ||
                    (company.Type && company.Type.toLowerCase().includes(query))
                );
            }
            
            // Filters
            if (typeFilter && company.Type !== typeFilter) match = false;
            if (batchFilter && company.Batch !== batchFilter) match = false;
            if (locationFilter && company.Location !== locationFilter) match = false;
            
            return match;
        });
        
        res.json({
            results: companies,
            total: companies.length
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * API: Get crawler data for a company
 * Endpoint: GET /api/companies/:id/crawler
 */
app.get('/api/companies/:id/crawler', (req, res) => {
    try {
        const id = parseInt(req.params.id);
        const companies = loadCompaniesData();
        
        if (id < 0 || id >= companies.length) {
            return res.status(404).json({ error: 'Company not found' });
        }
        
        const company = companies[id];
        res.json({
            name: company.Name,
            crawlerData: company.crawlerData || []
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Root endpoint
 */
app.get('/', (req, res) => {
    res.json({
        name: 'YC Companies Data API',
        version: '1.0.0',
        endpoints: {
            'GET /api/companies': 'Get all companies',
            'GET /api/companies/paginated': 'Get paginated companies (?page=1&limit=25)',
            'GET /api/companies/:id': 'Get company by index',
            'GET /api/stats': 'Get statistics',
            'GET /api/search': 'Search companies (?q=query&type=filter&batch=filter&location=filter)',
            'GET /api/companies/:id/crawler': 'Get crawler data for a company',
            'GET /health': 'Health check'
        }
    });
});

/**
 * Error handling middleware
 */
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

// Start Server
app.listen(PORT, () => {
    console.log(`\n🚀 YC Companies Data API Server`);
    console.log(`📊 Listening on http://localhost:${PORT}`);
    console.log(`\n📚 API Documentation:`);
    console.log(`   http://localhost:${PORT}/\n`);
    
    // Pre-load data
    try {
        loadCompaniesData();
    } catch (error) {
        console.error('Failed to pre-load data:', error);
    }
});

module.exports = app;
