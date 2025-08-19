using Microsoft.EntityFrameworkCore;
using PixieVisio.Server.Models;

namespace PixieVisio.Server.Data
{
    public class VisioDbContext : DbContext
    {
        public VisioDbContext(DbContextOptions<VisioDbContext> options) : base(options) { }

        public DbSet<Node> Nodes => Set<Node>();

        protected override void OnModelCreating(ModelBuilder modelBuilder)
        {
            modelBuilder.Entity<Node>()
                .HasKey(n => n.Id);
            modelBuilder.Entity<Node>()
                .HasIndex(n => n.ModelId);
            base.OnModelCreating(modelBuilder);
        }
    }
}
